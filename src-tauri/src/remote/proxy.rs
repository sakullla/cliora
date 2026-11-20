//! Remote SSH connections prefer the proxy this computer has enabled.
//!
//! The system proxy (Windows Internet Settings, macOS network settings) or the
//! conventional `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY` environment is detected in
//! the app; OpenSSH then runs Cliora itself as its `ProxyCommand`. The helper
//! tunnels through the proxy (HTTP CONNECT or SOCKS5) and falls back to a direct
//! connection when the proxy is down or cannot reach the host, so turning a proxy
//! off or on never strands a remote host.
//!
//! A host the proxy settings exclude (loopback, the bypass list, `NO_PROXY`) and a
//! host whose own SSH configuration already sets `ProxyCommand`/`ProxyJump` keep
//! their existing route. `CLIORA_SSH_PROXY=off` disables the route; a proxy URL
//! there selects that proxy instead of the detected one.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use super::RemoteTarget;

/// First argument OpenSSH passes when it starts Cliora as the proxy helper.
pub const HELPER_FLAG: &str = "--cliora-ssh-proxy";
const OVERRIDE_ENV: &str = "CLIORA_SSH_PROXY";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Http,
    Socks5,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Http => "http",
            Kind::Socks5 => "socks5",
        }
    }
    fn parse(text: &str) -> Option<Self> {
        match text {
            "http" => Some(Kind::Http),
            "socks5" => Some(Kind::Socks5),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub kind: Kind,
    pub host: String,
    pub port: u16,
}

/// A detected proxy and the hosts it must not be used for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub endpoint: Endpoint,
    pub bypass: Vec<String>,
    /// Windows `<local>` / macOS "exclude simple hostnames": names without a dot.
    pub bypass_simple: bool,
}

impl Settings {
    fn direct(endpoint: Endpoint) -> Self {
        Settings { endpoint, bypass: Vec::new(), bypass_simple: false }
    }

    /// Whether `host` must connect directly. Loopback never goes through a proxy.
    pub fn bypassed(&self, host: &str) -> bool {
        let host = host.trim().trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
        let ip = host.parse::<IpAddr>().ok();
        if host == "localhost" || host.ends_with(".localhost") || ip.is_some_and(|ip| ip.is_loopback()) {
            return true;
        }
        if self.bypass_simple && ip.is_none() && !host.contains('.') {
            return true;
        }
        self.bypass.iter().any(|pattern| bypass_matches(pattern, &host, ip))
    }
}

fn bypass_matches(pattern: &str, host: &str, ip: Option<IpAddr>) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    if pattern == "<local>" {
        return ip.is_none() && !host.contains('.');
    }
    if pattern.starts_with('<') {
        return false;
    }
    if let Some((network, bits)) = pattern.split_once('/') {
        return match (ip, cidr(network, bits)) {
            (Some(IpAddr::V4(address)), Some((network, mask))) => u32::from(address) & mask == network & mask,
            _ => false,
        };
    }
    if pattern.contains('*') {
        return wildcard(&pattern, host);
    }
    // NO_PROXY style: `example.com` and `.example.com` both cover subdomains.
    let suffix = pattern.trim_start_matches('.');
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

/// `10.0.0.0/8`, and the macOS shorthand `169.254/16`.
fn cidr(network: &str, bits: &str) -> Option<(u32, u32)> {
    let bits: u32 = bits.parse().ok().filter(|bits| *bits <= 32)?;
    let mut octets = [0u8; 4];
    let parts: Vec<&str> = network.split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    for (index, part) in parts.iter().enumerate() {
        octets[index] = part.parse().ok()?;
    }
    let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
    Some((u32::from(Ipv4Addr::from(octets)), mask))
}

fn wildcard(pattern: &str, text: &str) -> bool {
    let (pattern, text) = (pattern.as_bytes(), text.as_bytes());
    let (mut p, mut t, mut star, mut mark) = (0, 0, None, 0);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == text[t] || pattern[p] == b'?') {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(position) = star {
            p = position + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

/// `http://host:port`, `socks5://host:port`, `socks5h://…` or a bare `host:port`.
/// Authenticated and TLS proxies are not used: their secrets would have to be
/// handed to a helper process.
pub fn parse_url(value: &str) -> Option<Endpoint> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let text = if value.contains("://") { value.to_owned() } else { format!("http://{value}") };
    let url = url::Url::parse(&text).ok()?;
    let kind = match url.scheme() {
        "http" => Kind::Http,
        "socks5" | "socks5h" | "socks" => Kind::Socks5,
        _ => return None,
    };
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.trim_start_matches('[').trim_end_matches(']').to_owned();
    let port = url.port().unwrap_or(match kind {
        Kind::Http => 80,
        Kind::Socks5 => 1080,
    });
    (!host.is_empty() && port != 0).then_some(Endpoint { kind, host, port })
}

fn from_environment(lookup: impl Fn(&str) -> Option<String>) -> Option<Settings> {
    let endpoint = ["ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .into_iter()
        .filter_map(&lookup)
        .find_map(|value| parse_url(&value))?;
    let bypass = ["NO_PROXY", "no_proxy"]
        .into_iter()
        .filter_map(&lookup)
        .flat_map(|value| value.split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_owned).collect::<Vec<_>>())
        .collect();
    Some(Settings { endpoint, bypass, bypass_simple: false })
}

/// Windows `ProxyServer`: `host:port`, or per protocol `http=h:p;https=h:p;socks=h:p`.
pub fn parse_windows_server(server: &str) -> Option<Endpoint> {
    let server = server.trim();
    if !server.contains('=') {
        return parse_url(server.split(';').next()?);
    }
    let entries: HashMap<String, String> = server
        .split(';')
        .filter_map(|entry| entry.split_once('='))
        .map(|(scheme, address)| (scheme.trim().to_ascii_lowercase(), address.trim().to_owned()))
        .collect();
    for (scheme, kind) in [("https", Kind::Http), ("http", Kind::Http), ("socks", Kind::Socks5)] {
        if let Some(address) = entries.get(scheme) {
            let address = address.rsplit("://").next().unwrap_or(address);
            if let Some(endpoint) = parse_url(&format!("{}://{address}", kind.as_str())) {
                return Some(endpoint);
            }
        }
    }
    None
}

pub fn windows_settings(enabled: Option<u32>, server: Option<String>, overrides: Option<String>) -> Option<Settings> {
    if enabled.unwrap_or(0) == 0 {
        return None;
    }
    let endpoint = parse_windows_server(&server?)?;
    let mut settings = Settings::direct(endpoint);
    for item in overrides.unwrap_or_default().split(';').map(str::trim).filter(|item| !item.is_empty()) {
        if item.eq_ignore_ascii_case("<local>") {
            settings.bypass_simple = true;
        } else {
            settings.bypass.push(item.to_owned());
        }
    }
    Some(settings)
}

/// `scutil --proxy` output. SOCKS (SOCKS5 on macOS) is preferred, then HTTPS and HTTP.
pub fn parse_scutil(text: &str) -> Option<Settings> {
    let mut values = HashMap::new();
    let mut exceptions = Vec::new();
    let mut in_exceptions = false;
    for line in text.lines().map(str::trim) {
        if in_exceptions {
            if line.starts_with('}') {
                in_exceptions = false;
            } else if let Some((_, value)) = line.split_once(" : ") {
                exceptions.push(value.trim().to_owned());
            }
            continue;
        }
        let Some((key, value)) = line.split_once(" : ") else { continue };
        if key == "ExceptionsList" {
            in_exceptions = value.contains('{');
            continue;
        }
        values.insert(key.trim().to_owned(), value.trim().to_owned());
    }
    let enabled = |prefix: &str| values.get(&format!("{prefix}Enable")).is_some_and(|value| value == "1");
    let endpoint = [("SOCKS", Kind::Socks5), ("HTTPS", Kind::Http), ("HTTP", Kind::Http)].into_iter().find_map(|(prefix, kind)| {
        if !enabled(prefix) {
            return None;
        }
        let host = values.get(&format!("{prefix}Proxy"))?.clone();
        let port = values.get(&format!("{prefix}Port"))?.parse().ok().filter(|port| *port != 0)?;
        (!host.is_empty()).then_some(Endpoint { kind, host, port })
    })?;
    Some(Settings {
        endpoint,
        bypass: exceptions,
        bypass_simple: values.get("ExcludeSimpleHostnames").is_some_and(|value| value == "1"),
    })
}

fn system_settings() -> Option<Settings> {
    #[cfg(windows)]
    {
        const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
        windows_settings(
            crate::windows_registry::user_dword(KEY, "ProxyEnable"),
            crate::windows_registry::user_value(KEY, "ProxyServer"),
            crate::windows_registry::user_value(KEY, "ProxyOverride"),
        )
    }
    #[cfg(target_os = "macos")]
    {
        let output = bounded_output(Command::new("/usr/sbin/scutil").arg("--proxy"), Duration::from_secs(3))?;
        parse_scutil(&String::from_utf8_lossy(&output))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}

fn detect_uncached() -> Option<Settings> {
    if let Ok(value) = std::env::var(OVERRIDE_ENV) {
        let value = value.trim();
        if matches!(value.to_ascii_lowercase().as_str(), "off" | "direct" | "none" | "0" | "false") {
            return None;
        }
        if !value.is_empty() {
            return parse_url(value).map(Settings::direct);
        }
    }
    from_environment(|key| std::env::var(key).ok().filter(|value| !value.trim().is_empty())).or_else(system_settings)
}

/// The proxy currently enabled on this computer. Re-read every few seconds so
/// switching a proxy on or off applies to the next connection.
pub fn detect() -> Option<Settings> {
    type Detected = Option<(Instant, Option<Settings>)>;
    static CACHE: LazyLock<Mutex<Detected>> = LazyLock::new(|| Mutex::new(None));
    let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    if let Some((at, settings)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(3) {
            return settings.clone();
        }
    }
    let settings = detect_uncached();
    *cache = Some((Instant::now(), settings.clone()));
    settings
}

/// What the target's own SSH configuration resolves to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Resolution {
    pub hostname: Option<String>,
    pub has_proxy: bool,
}

pub fn parse_resolution(text: &str) -> Resolution {
    let mut resolution = Resolution::default();
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once(' ') else { continue };
        let value = value.trim();
        match key.to_ascii_lowercase().as_str() {
            "hostname" if !value.is_empty() => resolution.hostname = Some(value.to_owned()),
            "proxycommand" | "proxyjump" if !value.is_empty() && !value.eq_ignore_ascii_case("none") => resolution.has_proxy = true,
            _ => {}
        }
    }
    resolution
}

pub(super) fn bounded_output(command: &mut Command, deadline: Duration) -> Option<Vec<u8>> {
    super::hide_console_window(command);
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.by_ref().take(256 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let bytes = reader.join().ok()?;
                return status.success().then_some(bytes);
            }
            Ok(None) if started.elapsed() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|metadata| metadata.modified()).ok()
}

type ResolutionKey = (String, String, String, u16, Option<String>, Option<SystemTime>, Option<SystemTime>);

/// `ssh -G` for this target, cached until its configuration files change.
fn resolve(target: &RemoteTarget) -> Option<Resolution> {
    type Resolved = HashMap<ResolutionKey, (Instant, Option<Resolution>)>;
    static CACHE: LazyLock<Mutex<Resolved>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    let binary = std::env::var("CLIORA_SSH_BINARY").unwrap_or_else(|_| "ssh".into());
    let user_config = dirs::home_dir().map(|home| home.join(".ssh").join("config"));
    let key = (
        binary.clone(),
        target.user.clone(),
        target.host.clone(),
        target.port,
        target.ssh_config.clone(),
        user_config.as_deref().and_then(modified),
        target.ssh_config.as_deref().map(PathBuf::from).as_deref().and_then(modified),
    );
    if let Some((at, resolution)) = CACHE.lock().unwrap_or_else(|error| error.into_inner()).get(&key) {
        if at.elapsed() < Duration::from_secs(300) {
            return resolution.clone();
        }
    }
    let mut command = Command::new(&binary);
    command.arg("-G");
    if let Some(config) = target.ssh_config.as_deref() {
        command.args(["-F", config]);
    }
    command.args(["-o", &format!("Port={}", target.port)]).arg(format!("{}@{}", target.user, target.host));
    let resolution = bounded_output(&mut command, Duration::from_secs(5)).map(|bytes| parse_resolution(&String::from_utf8_lossy(&bytes)));
    let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    if cache.len() > 256 {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), resolution.clone()));
    resolution
}

/// One token of the `ProxyCommand` line. Both the Windows OpenSSH port (which
/// starts the command directly) and Unix/MSYS OpenSSH (`sh -c`) read a double-
/// quoted word the same way unless it holds characters a shell would expand.
fn quoted(token: &str) -> Option<String> {
    if token.is_empty() || token.chars().any(|ch| ch.is_control() || matches!(ch, '"' | '$' | '`')) || token.contains("\\\\") {
        return None;
    }
    Some(format!("\"{}\"", token.replace('%', "%%")))
}

pub fn proxy_command(executable: &Path, endpoint: &Endpoint) -> Option<String> {
    Some(format!(
        "{} {HELPER_FLAG} {} {} {} %h %p",
        quoted(&executable.to_string_lossy())?,
        endpoint.kind.as_str(),
        quoted(&endpoint.host)?,
        endpoint.port,
    ))
}

/// The `-o ProxyCommand=…` value for `target`, when this computer has a proxy
/// enabled and nothing else decides the route.
pub fn ssh_option(target: &RemoteTarget) -> Option<String> {
    if cfg!(test) {
        return None;
    }
    let settings = detect()?;
    // An SSH configuration that cannot be read, or that routes the host itself,
    // keeps the user's own connection path.
    let resolution = resolve(target)?;
    if resolution.has_proxy {
        return None;
    }
    let host = resolution.hostname.as_deref().unwrap_or(&target.host);
    if settings.bypassed(host) {
        return None;
    }
    let executable = std::env::current_exe().ok()?;
    proxy_command(&executable, &settings.endpoint).map(|command| format!("ProxyCommand={command}"))
}

const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Total time spent on the proxy before falling back; OpenSSH waits 12s
/// (`ConnectTimeout`) for the server greeting, so the direct path keeps room.
const PROXY_BUDGET: Duration = Duration::from_secs(6);
const TOTAL_BUDGET: Duration = Duration::from_secs(11);

fn remaining(deadline: Instant) -> Result<Duration, String> {
    deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()).ok_or_else(|| "连接超时".to_owned())
}

fn connect_any(host: &str, port: u16, deadline: Instant, cap: Duration) -> Result<TcpStream, String> {
    let addresses: Vec<SocketAddr> = (host, port).to_socket_addrs().map_err(|error| format!("无法解析 {host}：{error}"))?.collect();
    let mut last = format!("无法解析 {host}");
    for address in addresses {
        let wait = remaining(deadline)?.min(cap);
        match TcpStream::connect_timeout(&address, wait) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = format!("{address}：{error}"),
        }
    }
    Err(last)
}

fn authority(host: &str, port: u16) -> String {
    if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

/// HTTP CONNECT. Returns any tunnel bytes that arrived with the response.
fn http_connect(stream: &mut TcpStream, host: &str, port: u16) -> Result<Vec<u8>, String> {
    let target = authority(host, port);
    stream
        .write_all(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\n\r\n").as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    let mut buffer = [0u8; 1024];
    let end = loop {
        let count = stream.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("代理关闭了连接".into());
        }
        response.extend_from_slice(&buffer[..count]);
        if let Some(position) = response.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if response.len() > 16 * 1024 {
            return Err("代理响应过长".into());
        }
    };
    let status = String::from_utf8_lossy(&response[..end]).lines().next().unwrap_or_default().to_owned();
    let code = status.split_whitespace().nth(1).unwrap_or_default();
    if !status.starts_with("HTTP/") || !code.starts_with('2') {
        return Err(format!("代理拒绝连接：{}", status.trim()));
    }
    Ok(response[end..].to_vec())
}

fn socks5_connect(stream: &mut TcpStream, host: &str, port: u16) -> Result<(), String> {
    let io = |error: std::io::Error| error.to_string();
    stream.write_all(&[5, 1, 0]).map_err(io)?;
    let mut choice = [0u8; 2];
    stream.read_exact(&mut choice).map_err(io)?;
    if choice != [5, 0] {
        return Err("SOCKS5 代理需要认证或不可用".into());
    }
    let mut request = vec![5, 1, 0];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            request.push(1);
            request.extend_from_slice(&address.octets());
        }
        Ok(IpAddr::V6(address)) => {
            request.push(4);
            request.extend_from_slice(&address.octets());
        }
        Err(_) => {
            let name = host.as_bytes();
            if name.is_empty() || name.len() > 255 {
                return Err("主机名过长".into());
            }
            request.push(3);
            request.push(name.len() as u8);
            request.extend_from_slice(name);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).map_err(io)?;
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).map_err(io)?;
    if head[0] != 5 || head[1] != 0 {
        return Err(format!("SOCKS5 代理拒绝连接（{}）", head[1]));
    }
    let length = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut size = [0u8; 1];
            stream.read_exact(&mut size).map_err(io)?;
            size[0] as usize
        }
        _ => return Err("SOCKS5 响应无效".into()),
    };
    let mut rest = vec![0u8; length + 2];
    stream.read_exact(&mut rest).map_err(io)?;
    Ok(())
}

fn through_proxy(endpoint: &Endpoint, host: &str, port: u16, deadline: Instant) -> Result<(TcpStream, Vec<u8>), String> {
    let mut stream = connect_any(&endpoint.host, endpoint.port, deadline, PROXY_CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(remaining(deadline)?)).map_err(|error| error.to_string())?;
    stream.set_write_timeout(Some(remaining(deadline)?)).map_err(|error| error.to_string())?;
    let mut greeting = match endpoint.kind {
        Kind::Http => http_connect(&mut stream, host, port)?,
        Kind::Socks5 => {
            socks5_connect(&mut stream, host, port)?;
            Vec::new()
        }
    };
    // Some proxies acknowledge a tunnel before dialling the host and close it when
    // that fails. An SSH server speaks first, so wait for its greeting while a
    // direct connection is still possible. A silent server keeps the tunnel.
    if greeting.is_empty() {
        stream.set_read_timeout(Some(remaining(deadline)?)).map_err(|error| error.to_string())?;
        let mut buffer = [0u8; 4096];
        match stream.read(&mut buffer) {
            Ok(0) => return Err("代理建立隧道后关闭了连接".into()),
            Ok(count) => greeting.extend_from_slice(&buffer[..count]),
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    stream.set_read_timeout(None).map_err(|error| error.to_string())?;
    stream.set_write_timeout(None).map_err(|error| error.to_string())?;
    Ok((stream, greeting))
}

/// Prefer the proxy; connect directly when it fails. Returns the stream and the
/// server bytes already read from it.
pub fn connect(endpoint: &Endpoint, host: &str, port: u16) -> Result<(TcpStream, Vec<u8>), String> {
    let started = Instant::now();
    let proxy_error = match through_proxy(endpoint, host, port, started + PROXY_BUDGET) {
        Ok(connected) => return Ok(connected),
        Err(error) => error,
    };
    connect_any(host, port, started + TOTAL_BUDGET, TOTAL_BUDGET)
        .map(|stream| (stream, Vec::new()))
        .map_err(|direct| format!("通过代理 {} 连接失败（{proxy_error}），直接连接也失败（{direct}）", authority(&endpoint.host, endpoint.port)))
}

/// Copy `input` to the stream and the stream to `output` until the server closes.
pub fn relay(stream: TcpStream, greeting: &[u8], mut input: impl Read + Send + 'static, mut output: impl Write) -> Result<(), String> {
    let _ = stream.set_nodelay(true);
    let mut upstream = stream.try_clone().map_err(|error| error.to_string())?;
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            match input.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if upstream.write_all(&buffer[..count]).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = upstream.shutdown(Shutdown::Write);
    });
    let mut downstream = stream;
    if !greeting.is_empty() {
        output.write_all(greeting).and_then(|_| output.flush()).map_err(|error| error.to_string())?;
    }
    let mut buffer = vec![0u8; 32 * 1024];
    loop {
        match downstream.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => output.write_all(&buffer[..count]).and_then(|_| output.flush()).map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn helper(args: &[String]) -> Result<(), String> {
    let [kind, proxy_host, proxy_port, host, port] = args else {
        return Err("代理参数无效".into());
    };
    let endpoint = Endpoint {
        kind: Kind::parse(kind).ok_or("代理类型无效")?,
        host: proxy_host.clone(),
        port: proxy_port.parse().map_err(|_| "代理端口无效")?,
    };
    let port: u16 = port.parse().map_err(|_| "端口无效")?;
    let (stream, greeting) = connect(&endpoint, host, port)?;
    relay(stream, &greeting, std::io::stdin(), std::io::stdout().lock())
}

/// Proxy helper entry point. Returns `false` unless OpenSSH started this process
/// as its `ProxyCommand`; the process then exits without starting the app.
pub fn helper_entry() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(HELPER_FLAG) {
        return false;
    }
    match helper(&args[2..]) {
        Ok(()) => std::process::exit(0),
        Err(error) => {
            eprintln!("Cliora 代理连接：{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn proxy_urls_and_windows_servers_parse() {
        let http = Endpoint { kind: Kind::Http, host: "127.0.0.1".into(), port: 7890 };
        assert_eq!(parse_url("http://127.0.0.1:7890"), Some(http.clone()));
        assert_eq!(parse_url("127.0.0.1:7890"), Some(http.clone()));
        assert_eq!(parse_url("socks5h://localhost:1080/").map(|e| e.kind), Some(Kind::Socks5));
        assert_eq!(parse_url("socks5://[::1]:1080").map(|e| e.host), Some("::1".into()));
        assert_eq!(parse_url("https://proxy.example:443"), None, "TLS proxies are not used");
        assert_eq!(parse_url("http://user:secret@proxy.example:8080"), None, "credentials are not handed to the helper");
        assert_eq!(parse_url(""), None);

        assert_eq!(parse_windows_server("127.0.0.1:7890"), Some(http.clone()));
        assert_eq!(parse_windows_server("http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892").map(|e| e.port), Some(7891));
        assert_eq!(parse_windows_server("socks=127.0.0.1:7892"), Some(Endpoint { kind: Kind::Socks5, host: "127.0.0.1".into(), port: 7892 }));
        assert_eq!(parse_windows_server("ftp=127.0.0.1:21"), None);
    }

    /// The Internet Settings of a Clash-style system proxy (observed 2026-11-18).
    #[test]
    fn windows_settings_follow_enable_flag_and_override_list() {
        let overrides = "localhost;127.*;10.*;172.16.*;172.31.*;192.168.*;*.local;*.lan;<local>";
        assert!(windows_settings(Some(0), Some("127.0.0.1:7890".into()), None).is_none());
        assert!(windows_settings(None, Some("127.0.0.1:7890".into()), None).is_none());
        let settings = windows_settings(Some(1), Some("127.0.0.1:7890".into()), Some(overrides.into())).unwrap();
        assert_eq!(settings.endpoint.port, 7890);
        for host in ["192.168.1.20", "10.0.0.5", "nas.local", "router.lan", "devbox", "localhost", "127.0.0.1", "::1"] {
            assert!(settings.bypassed(host), "{host}");
        }
        for host in ["example.com", "203.0.113.8", "172.20.0.1", "github.com"] {
            assert!(!settings.bypassed(host), "{host}");
        }
    }

    #[test]
    fn environment_and_no_proxy_rules() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |key: &str| pairs.iter().find(|(name, _)| *name == key).map(|(_, value)| value.to_string());
        assert!(from_environment(env(&[])).is_none());
        let settings = from_environment(env(&[("https_proxy", "http://127.0.0.1:7890"), ("ALL_PROXY", "socks5://127.0.0.1:7891"), ("NO_PROXY", "internal.example, .corp,10.0.0.0/8")])).unwrap();
        assert_eq!(settings.endpoint.kind, Kind::Socks5, "ALL_PROXY wins");
        for host in ["internal.example", "a.internal.example", "build.corp", "10.2.3.4"] {
            assert!(settings.bypassed(host), "{host}");
        }
        assert!(!settings.bypassed("example.com"));
        assert!(!settings.bypassed("notinternal.example"));
        let everything = from_environment(env(&[("HTTP_PROXY", "127.0.0.1:3128"), ("no_proxy", "*")])).unwrap();
        assert!(everything.bypassed("example.com"));
    }

    #[test]
    fn macos_scutil_output_prefers_socks_and_reads_exceptions() {
        let text = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : 192.168.0.0/16\n    1 : 169.254/16\n    2 : *.local\n  }\n  ExcludeSimpleHostnames : 1\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 1\n  SOCKSPort : 7891\n  SOCKSProxy : 127.0.0.1\n}\n";
        let settings = parse_scutil(text).unwrap();
        assert_eq!(settings.endpoint, Endpoint { kind: Kind::Socks5, host: "127.0.0.1".into(), port: 7891 });
        for host in ["192.168.3.4", "169.254.1.1", "printer.local", "devbox"] {
            assert!(settings.bypassed(host), "{host}");
        }
        assert!(!settings.bypassed("example.com"));
        let http_only = text.replace("SOCKSEnable : 1", "SOCKSEnable : 0");
        assert_eq!(parse_scutil(&http_only).unwrap().endpoint.port, 7890);
        assert!(parse_scutil("<dictionary> {\n  HTTPEnable : 0\n}\n").is_none());
    }

    #[test]
    fn ssh_configuration_routes_are_respected() {
        let plain = parse_resolution("user root\nhostname 203.0.113.8\nport 22\n");
        assert_eq!(plain, Resolution { hostname: Some("203.0.113.8".into()), has_proxy: false });
        assert!(parse_resolution("hostname build\nproxyjump bastion\n").has_proxy);
        assert!(parse_resolution("hostname build\nproxycommand nc -X 5 -x 127.0.0.1:1080 %h %p\n").has_proxy);
        assert!(!parse_resolution("hostname build\nproxycommand none\n").has_proxy);
    }

    #[test]
    fn proxy_command_quotes_paths_for_both_openssh_flavours() {
        let endpoint = Endpoint { kind: Kind::Http, host: "127.0.0.1".into(), port: 7890 };
        assert_eq!(
            proxy_command(Path::new(r"C:\Program Files\Cliora 100%\cliora.exe"), &endpoint).unwrap(),
            "\"C:\\Program Files\\Cliora 100%%\\cliora.exe\" --cliora-ssh-proxy http \"127.0.0.1\" 7890 %h %p"
        );
        assert_eq!(
            proxy_command(Path::new("/Applications/Cliora.app/Contents/MacOS/cliora"), &Endpoint { kind: Kind::Socks5, ..endpoint.clone() }).unwrap(),
            "\"/Applications/Cliora.app/Contents/MacOS/cliora\" --cliora-ssh-proxy socks5 \"127.0.0.1\" 7890 %h %p"
        );
        // A path a shell would expand is never routed.
        assert!(proxy_command(Path::new("/opt/$HOME/cliora"), &endpoint).is_none());
        assert!(proxy_command(Path::new("/opt/a\"b/cliora"), &endpoint).is_none());
    }

    const GREETING: &[u8] = b"SSH-2.0-Fixture\r\n";

    /// A server that greets and then echoes everything back.
    fn ssh_server() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let _ = stream.write_all(GREETING);
                    let mut buffer = [0u8; 1024];
                    while let Ok(count) = stream.read(&mut buffer) {
                        if count == 0 || stream.write_all(&buffer[..count]).is_err() {
                            break;
                        }
                    }
                });
            }
        });
        address
    }

    fn pipe(mut a: TcpStream, mut b: TcpStream) {
        let (mut a2, mut b2) = (a.try_clone().unwrap(), b.try_clone().unwrap());
        std::thread::spawn(move || { let _ = std::io::copy(&mut a2, &mut b2); let _ = b2.shutdown(Shutdown::Write); });
        std::thread::spawn(move || { let _ = std::io::copy(&mut b, &mut a); let _ = a.shutdown(Shutdown::Write); });
    }

    /// `mode`: "ok" tunnels, "refuse" answers 403, "drop" acknowledges and closes.
    fn http_proxy(mode: &'static str, requests: std::sync::Arc<Mutex<Vec<String>>>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let requests = requests.clone();
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                        head.push(byte[0]);
                    }
                    let line = String::from_utf8_lossy(&head).lines().next().unwrap_or_default().to_owned();
                    requests.lock().unwrap().push(line.clone());
                    match mode {
                        "refuse" => { let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n"); }
                        "drop" => { let _ = stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n"); }
                        _ => {
                            let target = line.split_whitespace().nth(1).unwrap().to_owned();
                            let upstream = TcpStream::connect(target).unwrap();
                            stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").unwrap();
                            pipe(stream, upstream);
                        }
                    }
                });
            }
        });
        address
    }

    fn socks_proxy() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut hello = [0u8; 3];
                    stream.read_exact(&mut hello).unwrap();
                    stream.write_all(&[5, 0]).unwrap();
                    let mut head = [0u8; 4];
                    stream.read_exact(&mut head).unwrap();
                    assert_eq!(head[3], 3, "host names are resolved by the proxy");
                    let mut size = [0u8; 1];
                    stream.read_exact(&mut size).unwrap();
                    let mut name = vec![0u8; size[0] as usize];
                    stream.read_exact(&mut name).unwrap();
                    let mut port = [0u8; 2];
                    stream.read_exact(&mut port).unwrap();
                    let host = if name == b"server.fixture" { "127.0.0.1".to_owned() } else { String::from_utf8(name).unwrap() };
                    let upstream = TcpStream::connect((host.as_str(), u16::from_be_bytes(port))).unwrap();
                    stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap();
                    pipe(stream, upstream);
                });
            }
        });
        address
    }

    fn endpoint(kind: Kind, address: SocketAddr) -> Endpoint {
        Endpoint { kind, host: address.ip().to_string(), port: address.port() }
    }

    fn round_trip(endpoint: &Endpoint, host: &str, port: u16) -> Vec<u8> {
        let (stream, greeting) = connect(endpoint, host, port).unwrap();
        let mut output = Vec::new();
        relay(stream, &greeting, std::io::Cursor::new(b"client-hello".to_vec()), &mut output).unwrap();
        output
    }

    #[test]
    fn helper_tunnels_through_http_and_socks5_proxies() {
        let server = ssh_server();
        let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
        let http = http_proxy("ok", requests.clone());
        let output = round_trip(&endpoint(Kind::Http, http), "127.0.0.1", server.port());
        assert_eq!(output, [GREETING, b"client-hello"].concat());
        assert_eq!(requests.lock().unwrap().as_slice(), [format!("CONNECT 127.0.0.1:{} HTTP/1.1", server.port())]);

        let output = round_trip(&endpoint(Kind::Socks5, socks_proxy()), "server.fixture", server.port());
        assert_eq!(output, [GREETING, b"client-hello"].concat());
    }

    #[test]
    fn helper_falls_back_to_a_direct_connection() {
        let server = ssh_server();
        // Proxy not running: the port refuses connections.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        assert_eq!(round_trip(&endpoint(Kind::Http, closed), "127.0.0.1", server.port()), [GREETING, b"client-hello"].concat());
        // Proxy refuses the target, or acknowledges and then closes the tunnel.
        for mode in ["refuse", "drop"] {
            let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
            let proxy = http_proxy(mode, requests.clone());
            assert_eq!(round_trip(&endpoint(Kind::Http, proxy), "127.0.0.1", server.port()), [GREETING, b"client-hello"].concat(), "{mode}");
            assert_eq!(requests.lock().unwrap().len(), 1, "{mode}: the proxy was tried first");
        }
    }

    /// Host evidence: prints what this computer's proxy settings resolve to.
    #[test]
    #[ignore = "reads this computer's proxy settings"]
    fn host_proxy_detection() {
        println!("{:?}", detect_uncached());
    }

    #[test]
    fn helper_reports_both_failures() {
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let unreachable = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let error = connect(&endpoint(Kind::Http, closed), "127.0.0.1", unreachable.port()).unwrap_err();
        assert!(error.contains("通过代理") && error.contains("直接连接也失败"), "{error}");
    }
}
