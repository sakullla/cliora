//! No filesystem, module loader, process or browser API is installed in this VM.
use super::*;
use rquickjs::{Context, Function, Object, Promise, Runtime};
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    io::Read,
    net::{IpAddr, ToSocketAddrs},
    rc::Rc,
    sync::{mpsc, Arc},
    time::{Duration, Instant, SystemTime},
};

pub const HEAP_BYTES: usize = 32 * 1024 * 1024;
pub const STACK_BYTES: usize = 1024 * 1024;
pub const COMPUTE_BUDGET: Duration = Duration::from_secs(5);
pub const WALL_BUDGET: Duration = Duration::from_secs(30);
pub const HTTP_BUDGET: Duration = Duration::from_secs(10);
pub const MAX_REQUESTS: usize = 8;
pub const MAX_HTTP_ACTIVE: usize = 2;
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_IPC_BYTES: usize = 1024 * 1024;

// Secret-bearing types deliberately do not implement Debug.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct BoundSecret {
    pub name: String,
    pub allowed_origins: Vec<String>,
    pub value: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct HelperInput {
    pub config: QueryConfig,
    pub secrets: Vec<BoundSecret>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReport {
    pub result: Option<UsageResult>,
    pub error: Option<UsageError>,
    pub elapsed_ms: u64,
    pub stage: UsageStage,
    pub preview: String,
    /// Origins requested by this draft; no URL path, query, headers or body.
    #[serde(default)]
    pub request_origins: Vec<String>,
}
impl RuntimeReport {
    pub(super) fn failure(error: UsageError, start: Instant) -> Self {
        Self {
            stage: error.stage.clone(),
            error: Some(error),
            result: None,
            elapsed_ms: start.elapsed().as_millis() as u64,
            preview: String::new(),
            request_origins: Vec::new(),
        }
    }
}
fn error(code: UsageErrorCode, stage: UsageStage, message: &str) -> UsageError {
    UsageError::new(code, stage, message)
}
fn limit(stage: UsageStage) -> UsageError {
    error(UsageErrorCode::ResourceLimit, stage, "查询超过资源预算")
}

fn retry_after_seconds(value: &str, now: SystemTime) -> Option<u32> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        // Saturate even values larger than u64 instead of discarding the server delay.
        return Some(value.bytes().fold(0u32, |seconds, digit| {
            seconds
                .saturating_mul(10)
                .saturating_add(u32::from(digit - b'0'))
        }));
    }
    let deadline = httpdate::parse_http_date(value).ok()?;
    let remaining = deadline.duration_since(now).unwrap_or(Duration::ZERO);
    // Round up so a fractional second never schedules a refresh before the deadline.
    let seconds = remaining
        .as_secs()
        .saturating_add(u64::from(remaining.subsec_nanos() != 0));
    Some(seconds.min(u64::from(u32::MAX)) as u32)
}

/// Redact values before serializing, so JSON escaping cannot hide a known secret.
pub(super) fn redact_value(value: &mut serde_json::Value, secrets: &[BoundSecret]) {
    match value {
        serde_json::Value::String(text) => {
            for secret in secrets {
                *text = text.replace(&secret.value, "[redacted]");
            }
        }
        serde_json::Value::Array(values) => {
            values.iter_mut().for_each(|v| redact_value(v, secrets))
        }
        serde_json::Value::Object(values) => {
            let old = std::mem::take(values);
            for (mut key, mut value) in old {
                for secret in secrets {
                    key = key.replace(&secret.value, "[redacted]");
                }
                redact_value(&mut value, secrets);
                values.insert(key, value);
            }
        }
        _ => {}
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpRequest {
    url: String,
    #[serde(default = "get_method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    json: Option<serde_json::Value>,
    form: Option<BTreeMap<String, String>>,
    auth: Option<Auth>,
}
fn get_method() -> String {
    "GET".into()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Auth {
    credential: String,
    #[serde(default = "authorization")]
    header: String,
    #[serde(default)]
    prefix: String,
}
fn authorization() -> String {
    "Authorization".into()
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_multicast()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 240
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                || (ip.octets()[0] == 198 && (18..=19).contains(&ip.octets()[1])))
        }
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or_else(
            || {
                let s = ip.segments();
                (s[0] & 0xe000) == 0x2000
                    && s[0] != 0x2002
                    && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
            },
            |v| public_ip(IpAddr::V4(v)),
        ),
    }
}

fn http(
    input: &HelperInput,
    raw: &str,
    deadline: Instant,
) -> Result<serde_json::Value, UsageError> {
    let invalid = || {
        error(
            UsageErrorCode::Permission,
            UsageStage::Http,
            "请求目标、认证或格式不被允许",
        )
    };
    let req: HttpRequest = serde_json::from_str(raw).map_err(|_| invalid())?;
    let url = url::Url::parse(&req.url).map_err(|_| invalid())?;
    let origin = url.origin().ascii_serialization();
    let target = input
        .config
        .targets
        .iter()
        .find(|t| t.origin == origin)
        .ok_or_else(invalid)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !matches!(req.method.as_str(), "GET" | "POST")
        || (req.json.is_some() && req.form.is_some())
        || (req.method == "GET" && (req.json.is_some() || req.form.is_some()))
    {
        return Err(invalid());
    }
    let host = url.host_str().ok_or_else(invalid)?.trim_matches(['[', ']']);
    let addresses: Vec<_> = (host, url.port_or_known_default().ok_or_else(invalid)?)
        .to_socket_addrs()
        .map_err(|_| error(UsageErrorCode::Network, UsageStage::Http, "目标解析失败"))?
        .collect();
    if addresses.is_empty()
        || (!target.allow_private_network && addresses.iter().any(|a| !public_ip(a.ip())))
    {
        return Err(invalid());
    }
    if url.scheme() == "http"
        && addresses.iter().any(|a| match a.ip() {
            IpAddr::V4(ip) => !(ip.is_loopback() || ip.is_private() || ip.is_link_local()),
            IpAddr::V6(ip) => {
                !(ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local())
            }
        })
    {
        return Err(invalid());
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(error(UsageErrorCode::Timeout, UsageStage::Http, "查询超时"));
    }
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_BUDGET.min(remaining))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| error(UsageErrorCode::Network, UsageStage::Http, "HTTP 初始化失败"))?;
    let mut builder = client.request(
        if req.method == "GET" {
            reqwest::Method::GET
        } else {
            reqwest::Method::POST
        },
        url,
    );
    for (name, value) in req.headers {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host"
                | "cookie"
                | "authorization"
                | "proxy-authorization"
                | "content-length"
                | "transfer-encoding"
                | "connection"
                | "accept-encoding"
        ) {
            return Err(invalid());
        }
        builder = builder.header(name, value);
    }
    if let Some(auth) = req.auth {
        let secret = input
            .secrets
            .iter()
            .find(|s| s.name == auth.credential)
            .ok_or_else(invalid)?;
        if !secret.allowed_origins.contains(&origin)
            || matches!(
                auth.header.to_ascii_lowercase().as_str(),
                "host"
                    | "content-length"
                    | "transfer-encoding"
                    | "connection"
                    | "proxy-authorization"
                    | "accept-encoding"
            )
        {
            return Err(invalid());
        }
        builder = builder.header(auth.header, format!("{}{}", auth.prefix, secret.value));
    }
    if let Some(json) = req.json {
        builder = builder.json(&json);
    }
    if let Some(form) = req.form {
        let encoded = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form)
            .finish();
        builder = builder
            .header("content-type", "application/x-www-form-urlencoded")
            .body(encoded);
    }
    let network = |e: reqwest::Error| {
        error(
            if e.is_timeout() {
                UsageErrorCode::Timeout
            } else {
                UsageErrorCode::Network
            },
            UsageStage::Http,
            "HTTP 请求失败",
        )
    };
    let response = builder.send().map_err(network)?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let mut failure = error(
            match status {
                401 => UsageErrorCode::Authentication,
                403 => UsageErrorCode::Permission,
                429 => UsageErrorCode::RateLimit,
                300..=399 => UsageErrorCode::Permission,
                _ => UsageErrorCode::Network,
            },
            UsageStage::Http,
            "HTTP 状态拒绝查询（不跟随重定向）",
        );
        failure.retry_after_seconds = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| retry_after_seconds(v, SystemTime::now()));
        return Err(failure);
    }
    if response.headers().contains_key("content-encoding") {
        return Err(error(
            UsageErrorCode::Parse,
            UsageStage::Http,
            "不支持的响应压缩格式",
        ));
    }
    let mut body = Vec::new();
    response
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| error(UsageErrorCode::Network, UsageStage::Http, "响应读取失败"))?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(limit(UsageStage::Http));
    }
    let mut body = String::from_utf8(body)
        .map_err(|_| error(UsageErrorCode::Parse, UsageStage::Http, "响应不是 UTF-8"))?;
    // Do not expose server-echoed credentials back to arbitrary JS.
    if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&body) {
        redact_value(&mut json, &input.secrets);
        body = json.to_string();
    } else {
        for secret in &input.secrets {
            body = body.replace(&secret.value, "[redacted]");
        }
    }
    Ok(serde_json::json!({"status": status, "body": body}))
}

const BRIDGE: &str = r#"(function(submit, data) {
  const parse = JSON.parse, stringify = JSON.stringify, P = Promise, finite = Number.isFinite;
  const pending = new Map(), mapSet = Map.prototype.set, mapGet = Map.prototype.get, mapDelete = Map.prototype.delete;
  const apply = Reflect.apply, freeze = Object.freeze;
  const http = request => new P((resolve, reject) => {
    const id = submit(stringify(request));
    if (id < 0) { reject({code:'resource_limit',stage:'http',message:'Request budget exceeded',retryAfterSeconds:null,metricId:null}); return; }
    apply(mapSet, pending, [id, {resolve,reject}]);
  });
  const ctx = freeze({version:1, parameters:data.parameters, credentials:freeze(data.credentials), http});
  return {
    run: async query => {
      try { return stringify({ok:true, value:await query(ctx)}, (key,value) => {
        if (typeof value === 'number' && !finite(value)) throw new Error('Nonfinite result');
        return value;
      }); }
      catch (e) { return stringify({ok:false, error: e && typeof e === 'object' ? {
        code:e.code || 'script', stage:e.stage || 'script', message:e.code ? e.message : 'JavaScript 执行失败', retryAfterSeconds:e.retryAfterSeconds ?? null, metricId:null,
        scriptLine:e.code ? undefined : (() => { const m=String(e.stack || '').match(/usage-script\.js:(\d+)/); return m ? Math.max(1, Number(m[1])-1) : undefined; })()
      } : null}); }
    },
    settle: (id, raw) => {
      const entry = apply(mapGet,pending,[id]); apply(mapDelete,pending,[id]);
      const result = parse(raw);
      if (result.error) entry.reject(result.error);
      else { const body=result.value.body; entry.resolve(freeze({status:result.value.status, text:()=>body, json:()=>parse(body)})); }
    }
  };
})"#;

pub(super) fn execute(input: HelperInput) -> RuntimeReport {
    let start = Instant::now();
    let mut request_origins = Vec::new();
    let mut report = match run(&input, start, &mut request_origins) {
        Ok(mut value) => {
            redact_value(&mut value, &input.secrets);
            match serde_json::from_value::<UsageResult>(value) {
                Ok(result) => match result.validate() {
                    Ok(()) => {
                        let preview = serde_json::to_string(&result)
                            .unwrap_or_default()
                            .chars()
                            .take(4096)
                            .collect();
                        RuntimeReport {
                            result: Some(result),
                            error: None,
                            elapsed_ms: start.elapsed().as_millis() as u64,
                            stage: UsageStage::Validation,
                            preview,
                            request_origins: Vec::new(),
                        }
                    }
                    Err(e) => RuntimeReport::failure(e, start),
                },
                Err(_) => RuntimeReport::failure(
                    error(
                        UsageErrorCode::ResultContract,
                        UsageStage::Validation,
                        "脚本返回值不符合额度契约",
                    ),
                    start,
                ),
            }
        }
        Err(mut failure) => {
            for secret in &input.secrets {
                failure.message = failure.message.replace(&secret.value, "[redacted]");
            }
            failure.message = failure.message.chars().take(512).collect();
            RuntimeReport::failure(failure, start)
        }
    };
    for origin in &mut request_origins {
        for secret in &input.secrets { *origin=origin.replace(&secret.value,"[redacted]"); }
    }
    report.request_origins=request_origins;
    report
}

fn run(input: &HelperInput, start: Instant, request_origins:&mut Vec<String>) -> Result<serde_json::Value, UsageError> {
    input.config.validate()?;
    let source = match &input.config.program {
        QueryProgram::Official { .. } => return Err(UsageError::configuration("官方账号查询只由原生账号服务执行")),
        QueryProgram::JavaScript { source } => std::borrow::Cow::Borrowed(source.as_str()),
        QueryProgram::Builtin { .. } => {
            super::providers::validate_builtin_credentials(input)?;
            std::borrow::Cow::Owned(super::providers::builtin_script(&input.config)?)
        }
    };
    let vm_error = || limit(UsageStage::Script);
    let runtime = Runtime::new().map_err(|_| vm_error())?;
    runtime.set_memory_limit(HEAP_BYTES);
    runtime.set_max_stack_size(STACK_BYTES);
    let used = Rc::new(Cell::new(Duration::ZERO));
    let slice = Rc::new(Cell::new(Instant::now()));
    let interrupted = Rc::new(Cell::new(false));
    let (u, s, i) = (used.clone(), slice.clone(), interrupted.clone());
    runtime.set_interrupt_handler(Some(Box::new(move || {
        let stop = u.get() + s.get().elapsed() >= COMPUTE_BUDGET || start.elapsed() >= WALL_BUDGET;
        if stop {
            i.set(true);
        }
        stop
    })));
    let context = Context::full(&runtime).map_err(|_| vm_error())?;
    let queue = Rc::new(RefCell::new(VecDeque::<(usize, String)>::new()));
    let count = Rc::new(Cell::new(0usize));
    let terminal_limit = Rc::new(Cell::new(false));
    context.with(|ctx| {
        let arm = || slice.set(Instant::now());
        let disarm = || used.set(used.get() + slice.get().elapsed());
        let js_error = || if interrupted.get() { vm_error() } else {
            error(UsageErrorCode::Script, UsageStage::Script, "JavaScript 执行失败或内存/栈预算耗尽")
        };
        let (q,c,l) = (queue.clone(),count.clone(),terminal_limit.clone());
        let submit = Function::new(ctx.clone(), move |raw: String| -> i32 {
            if c.get() >= MAX_REQUESTS || raw.len() > MAX_RESULT_BYTES { l.set(true); return -1; }
            let id = c.get(); c.set(id + 1); q.borrow_mut().push_back((id, raw)); id as i32
        }).map_err(|_| vm_error())?;
        let data = serde_json::json!({"parameters":input.config.parameters,
            "credentials":input.secrets.iter().map(|s| (s.name.clone(),s.name.clone())).collect::<BTreeMap<_,_>>()});
        arm();
        let factory: Function = ctx.eval(BRIDGE).map_err(|_| js_error())?;
        let data = ctx.json_parse(data.to_string()).map_err(|_| js_error())?;
        let bridge: Object = factory.call((submit, data)).map_err(|_| js_error())?;
        let runner: Function = bridge.get("run").map_err(|_| js_error())?;
        let settle: Function = bridge.get("settle").map_err(|_| js_error())?;
        let mut options = rquickjs::context::EvalOptions::default();
        options.filename = Some("usage-script.js".into());
        let query: Function = ctx.eval_with_options(format!("(function(){{'use strict';\n{source}\n;return query;}})()"), options)
            .map_err(|_| {
                let mut failure=js_error();
                let exception=ctx.catch();
                if let Some(object)=exception.as_object() {
                    if let Ok(stack)=object.get::<_,String>("stack") {
                        if let Some(tail)=stack.split("usage-script.js:").nth(1) {
                            let digits:String=tail.chars().take_while(|c|c.is_ascii_digit()).collect();
                            failure.script_line=digits.parse::<u32>().ok().map(|n|n.saturating_sub(1).max(1));
                        }
                    }
                }
                failure
            })?;
        let promise: Promise = runner.call((query,)).map_err(|_| js_error())?;
        disarm();
        let (tx, rx) = mpsc::channel();
        let mut active = BTreeMap::<usize, Instant>::new();
        let shared = Arc::new(input.clone());
        loop {
            if terminal_limit.get() { return Err(limit(UsageStage::Http)); }
            if start.elapsed() >= WALL_BUDGET { return Err(error(UsageErrorCode::Timeout, UsageStage::Script, "查询墙钟超时")); }
            if used.get() >= COMPUTE_BUDGET { return Err(vm_error()); }
            if active.values().any(|began| began.elapsed() >= HTTP_BUDGET) {
                return Err(error(UsageErrorCode::Timeout, UsageStage::Http, "HTTP 请求超时（含 DNS 与响应读取）"));
            }
            arm();
            // One job at a time: an infinite microtask chain cannot starve host checks.
            let pending = ctx.execute_pending_job();
            disarm();
            if interrupted.get() { return Err(vm_error()); }
            if terminal_limit.get() { return Err(limit(UsageStage::Http)); }
            if let Some(result) = promise.result::<String>() {
                let raw = result.map_err(|_| js_error())?;
                if raw.len() > MAX_RESULT_BYTES { return Err(limit(UsageStage::Validation)); }
                let envelope: serde_json::Value = serde_json::from_str(&raw).map_err(|_| js_error())?;
                if envelope["ok"] == true { return Ok(envelope["value"].clone()); }
                let failure = serde_json::from_value::<UsageError>(envelope["error"].clone()).unwrap_or_else(|_| js_error());
                return Err(failure);
            }
            while active.len() < MAX_HTTP_ACTIVE {
                let Some((id, raw)) = queue.borrow_mut().pop_front() else { break; };
                if let Ok(request) = serde_json::from_str::<HttpRequest>(&raw) {
                    if let Ok(url) = url::Url::parse(&request.url) {
                        let origin=url.origin().ascii_serialization();
                        if !request_origins.contains(&origin) { request_origins.push(origin); }
                    }
                }
                let (tx, shared) = (tx.clone(), shared.clone());
                let began = Instant::now();
                active.insert(id, began);
                std::thread::spawn(move || {
                    let response = match http(&shared, &raw, (began + HTTP_BUDGET).min(start + WALL_BUDGET)) {
                        Ok(value) => serde_json::json!({"value":value}),
                        Err(error) => serde_json::json!({"error":error}),
                    };
                    let _ = tx.send((id, response.to_string()));
                });
            }
            let response = if pending { rx.try_recv().ok() } else { rx.recv_timeout(Duration::from_millis(5)).ok() };
            if let Some((id, response)) = response {
                active.remove(&id); arm();
                settle.call::<_, ()>((id as i32, response)).map_err(|_| js_error())?;
                disarm();
            }
        }
    })
}

#[cfg(test)]
#[path = "../../../tests/usage/runtime.rs"]
mod tests;
