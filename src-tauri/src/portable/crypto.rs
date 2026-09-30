use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use rand::Rng;
use serde::{Deserialize, Serialize};

const MAX_CONTAINER: usize = 96 * 1024 * 1024;
pub const MAX_PLAINTEXT: usize = 64 * 1024 * 1024;
const MEMORY_KIB: u32 = 64 * 1024;
const ITERATIONS: u32 = 3;
const LANES: u32 = 4;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    magic: String,
    version: u32,
    purpose: String,
    epoch: u32,
    kdf: String,
    memory_kib: u32,
    iterations: u32,
    lanes: u32,
    salt: String,
    wrap_nonce: String,
    content_nonce: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Container {
    header: Header,
    wrapped_key: String,
    ciphertext: String,
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    rand::rng().fill(&mut bytes);
    bytes
}

fn decode<const N: usize>(value: &str) -> Result<[u8; N], String> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "加密包头损坏".to_string())?;
    bytes.try_into().map_err(|_| "加密包头长度无效".into())
}

fn wrapping_key(password: &str, header: &Header) -> Result<[u8; 32], String> {
    if password.is_empty() {
        return Err("请输入配置包口令".into());
    }
    if header.kdf != "argon2id"
        || !(8 * 1024..=MEMORY_KIB).contains(&header.memory_kib)
        || !(1..=ITERATIONS).contains(&header.iterations)
        || !(1..=LANES).contains(&header.lanes)
    {
        return Err("配置包密钥派生参数不受支持".into());
    }
    let salt = decode::<16>(&header.salt)?;
    let params = argon2::Params::new(header.memory_kib, header.iterations, header.lanes, Some(32))
        .map_err(|_| "配置包密钥派生参数无效".to_string())?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|_| "无法解锁配置包".to_string())?;
    Ok(key)
}

fn header_bytes(header: &Header) -> Result<Vec<u8>, String> {
    serde_json::to_vec(header).map_err(|_| "无法处理加密包头".into())
}

pub fn seal(password: &str, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if password.len() < 12 {
        return Err("配置包口令至少需要 12 位".into());
    }
    if plaintext.len() > MAX_PLAINTEXT {
        return Err("可迁移资料超过 64 MiB".into());
    }
    if !matches!(purpose, "offline" | "webdav") {
        return Err("加密包用途无效".into());
    }
    let data_key = random::<32>();
    let header = Header {
        magic: "cliora-portable".into(),
        version: 1,
        purpose: purpose.into(),
        epoch: 1,
        kdf: "argon2id".into(),
        memory_kib: MEMORY_KIB,
        iterations: ITERATIONS,
        lanes: LANES,
        salt: STANDARD.encode(random::<16>()),
        wrap_nonce: STANDARD.encode(random::<24>()),
        content_nonce: STANDARD.encode(random::<24>()),
    };
    let aad = header_bytes(&header)?;
    let wrap_key = wrapping_key(password, &header)?;
    let wrapped_key = XChaCha20Poly1305::new(Key::from_slice(&wrap_key))
        .encrypt(
            XNonce::from_slice(&decode::<24>(&header.wrap_nonce)?),
            Payload {
                msg: &data_key,
                aad: &aad,
            },
        )
        .map_err(|_| "无法加密资料密钥".to_string())?;
    let ciphertext = XChaCha20Poly1305::new(Key::from_slice(&data_key))
        .encrypt(
            XNonce::from_slice(&decode::<24>(&header.content_nonce)?),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "无法加密配置包".to_string())?;
    let bytes = serde_json::to_vec(&Container {
        header,
        wrapped_key: STANDARD.encode(wrapped_key),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|_| "无法生成配置包".to_string())?;
    if bytes.len() > MAX_CONTAINER {
        return Err("配置包超过大小限制".into());
    }
    Ok(bytes)
}

pub fn open(password: &str, purpose: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_CONTAINER {
        return Err("配置包超过大小限制".into());
    }
    let container: Container =
        serde_json::from_slice(bytes).map_err(|_| "配置包格式无法识别".to_string())?;
    let header = &container.header;
    if header.magic != "cliora-portable"
        || header.version != 1
        || header.epoch != 1
        || header.purpose != purpose
    {
        return Err("配置包版本或用途不受支持".into());
    }
    let aad = header_bytes(header)?;
    let wrap_key = wrapping_key(password, header)?;
    let wrapped = STANDARD
        .decode(&container.wrapped_key)
        .map_err(|_| "资料密钥损坏".to_string())?;
    if wrapped.len() != 48 {
        return Err("资料密钥长度无效".into());
    }
    let data_key = XChaCha20Poly1305::new(Key::from_slice(&wrap_key))
        .decrypt(
            XNonce::from_slice(&decode::<24>(&header.wrap_nonce)?),
            Payload {
                msg: &wrapped,
                aad: &aad,
            },
        )
        .map_err(|_| "口令错误或配置包已损坏".to_string())?;
    let data_key: [u8; 32] = data_key
        .try_into()
        .map_err(|_| "资料密钥长度无效".to_string())?;
    let ciphertext = STANDARD
        .decode(&container.ciphertext)
        .map_err(|_| "配置包密文损坏".to_string())?;
    if ciphertext.len() > MAX_PLAINTEXT + 16 {
        return Err("配置包解密大小超过限制".into());
    }
    let plaintext = XChaCha20Poly1305::new(Key::from_slice(&data_key))
        .decrypt(
            XNonce::from_slice(&decode::<24>(&header.content_nonce)?),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| "口令错误或配置包已损坏".to_string())?;
    if plaintext.len() > MAX_PLAINTEXT {
        return Err("配置包内容超过大小限制".into());
    }
    Ok(plaintext)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncEnvelope {
    magic: String,
    version: u32,
    space_id: String,
    nonce: String,
    wrap_nonce: String,
    wrapped_key: String,
    ciphertext: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncSpace {
    magic: String,
    version: u32,
    space_id: String,
    salt: String,
    nonce: String,
    wrapped_key: String,
}

fn sync_wrapping_key(password: &str, salt: &[u8; 16]) -> Result<[u8; 32], String> {
    if password.len() < 12 {
        return Err("同步加密口令至少需要 12 位".into());
    }
    let params = argon2::Params::new(MEMORY_KIB, ITERATIONS, LANES, Some(32))
        .map_err(|_| "同步密钥参数无效".to_string())?;
    let mut key = [0u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|_| "同步密钥无法生成".to_string())?;
    Ok(key)
}

pub fn make_sync_space(password: &str) -> Result<(String, [u8; 32], Vec<u8>), String> {
    let space_id = uuid::Uuid::new_v4().to_string();
    let key = random::<32>();
    let salt = random::<16>();
    let nonce = random::<24>();
    let wrap_key = sync_wrapping_key(password, &salt)?;
    let aad = format!("cliora-sync-space-v1:{space_id}");
    let wrapped = XChaCha20Poly1305::new(Key::from_slice(&wrap_key))
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &key,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "无法加密同步空间密钥".to_string())?;
    let bytes = serde_json::to_vec(&SyncSpace {
        magic: "cliora-sync-space".into(),
        version: 1,
        space_id: space_id.clone(),
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        wrapped_key: STANDARD.encode(wrapped),
    })
    .map_err(|_| "无法生成同步空间".to_string())?;
    Ok((space_id, key, bytes))
}

pub fn open_sync_space(password: &str, bytes: &[u8]) -> Result<(String, [u8; 32]), String> {
    if bytes.len() > 8192 {
        return Err("同步空间头过大".into());
    }
    let space: SyncSpace =
        serde_json::from_slice(bytes).map_err(|_| "同步空间头损坏".to_string())?;
    if space.magic != "cliora-sync-space"
        || space.version != 1
        || uuid::Uuid::parse_str(&space.space_id).is_err()
    {
        return Err("同步空间版本不受支持".into());
    }
    let salt = decode::<16>(&space.salt)?;
    let nonce = decode::<24>(&space.nonce)?;
    let wrapped = STANDARD
        .decode(&space.wrapped_key)
        .map_err(|_| "同步空间密钥损坏".to_string())?;
    if wrapped.len() != 48 {
        return Err("同步空间密钥长度无效".into());
    }
    let wrap_key = sync_wrapping_key(password, &salt)?;
    let aad = format!("cliora-sync-space-v1:{}", space.space_id);
    let data_key = XChaCha20Poly1305::new(Key::from_slice(&wrap_key))
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &wrapped,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "同步加密口令错误或空间头损坏".to_string())?;
    Ok((
        space.space_id,
        data_key
            .try_into()
            .map_err(|_| "同步空间密钥长度无效".to_string())?,
    ))
}

pub fn seal_sync(key: &[u8; 32], space_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err("同步资料超过大小限制".into());
    }
    let nonce = random::<24>();
    let wrap_nonce = random::<24>();
    let object_key = random::<32>();
    let aad = format!("cliora-sync-v1:{space_id}");
    let wrapped_key = XChaCha20Poly1305::new(Key::from_slice(key))
        .encrypt(
            XNonce::from_slice(&wrap_nonce),
            Payload {
                msg: &object_key,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "无法包装同步对象密钥".to_string())?;
    let ciphertext = XChaCha20Poly1305::new(Key::from_slice(&object_key))
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "无法加密同步资料".to_string())?;
    serde_json::to_vec(&SyncEnvelope {
        magic: "cliora-sync".into(),
        version: 1,
        space_id: space_id.into(),
        nonce: STANDARD.encode(nonce),
        wrap_nonce: STANDARD.encode(wrap_nonce),
        wrapped_key: STANDARD.encode(wrapped_key),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|_| "无法生成同步资料".to_string())
}

pub fn open_sync(key: &[u8; 32], space_id: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_CONTAINER {
        return Err("同步资料超过大小限制".into());
    }
    let envelope: SyncEnvelope =
        serde_json::from_slice(bytes).map_err(|_| "同步资料格式损坏".to_string())?;
    if envelope.magic != "cliora-sync" || envelope.version != 1 || envelope.space_id != space_id {
        return Err("同步空间或版本不匹配".into());
    }
    let nonce = decode::<24>(&envelope.nonce)?;
    let wrap_nonce = decode::<24>(&envelope.wrap_nonce)?;
    let wrapped = STANDARD
        .decode(&envelope.wrapped_key)
        .map_err(|_| "同步对象密钥损坏".to_string())?;
    if wrapped.len() != 48 {
        return Err("同步对象密钥长度无效".into());
    }
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| "同步密文损坏".to_string())?;
    if ciphertext.len() > MAX_PLAINTEXT + 16 {
        return Err("同步密文超过大小限制".into());
    }
    let aad = format!("cliora-sync-v1:{space_id}");
    let object_key = XChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(
            XNonce::from_slice(&wrap_nonce),
            Payload {
                msg: &wrapped,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "同步对象密钥认证失败".to_string())?;
    let object_key: [u8; 32] = object_key
        .try_into()
        .map_err(|_| "同步对象密钥长度无效".to_string())?;
    XChaCha20Poly1305::new(Key::from_slice(&object_key))
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "同步口令错误或远端资料已损坏".to_string())
}

pub fn peek_sync_space(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_CONTAINER {
        return Err("同步资料超过大小限制".into());
    }
    let envelope: SyncEnvelope =
        serde_json::from_slice(bytes).map_err(|_| "同步资料格式损坏".to_string())?;
    if envelope.magic != "cliora-sync"
        || envelope.version != 1
        || uuid::Uuid::parse_str(&envelope.space_id).is_err()
    {
        return Err("同步空间或版本不匹配".into());
    }
    Ok(envelope.space_id)
}
