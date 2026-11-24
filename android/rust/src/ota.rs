use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub const HERMES_BYTECODE_MAGIC: [u8; 8] = 0x1F1903C103BC1FC6u64.to_le_bytes();
pub const MAX_UNCONFIRMED_LAUNCH_ATTEMPTS: u32 = 2;
const MAX_FAILED_IDS: usize = 32;

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// Standard FIPS 180-4 SHA-256 hex digest using pure Rust `std`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let rem = data.len() % 64;
    let pad_zeros = if rem < 56 { 56 - rem - 1 } else { 64 + 56 - rem - 1 };
    let mut padded = Vec::with_capacity(data.len() + 1 + pad_zeros + 8);
    padded.extend_from_slice(data);
    padded.push(0x80);
    padded.resize(padded.len() + pad_zeros, 0);
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for block in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, chunk) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    let mut out = String::with_capacity(64);
    for word in state {
        use std::fmt::Write as _;
        let _ = write!(out, "{word:08x}");
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EmbeddedMeta {
    pub version_code: u64,
    pub runtime_version: String,
    pub embedded_build_id: String,
    pub embedded_format: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleSlot {
    pub id: String,
    pub sha256: String,
    pub format: String,
    pub bundle_rel: String,
    pub confirmed: bool,
    pub attempts: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OtaState {
    pub base_version_code: u64,
    pub runtime_version: String,
    pub embedded_build_id: String,
    pub active: Option<BundleSlot>,
    pub prev: Option<BundleSlot>,
    pub staged: Option<BundleSlot>,
    pub failed_ids: Vec<String>,
    pub last_rollback_reason: String,
    pub last_checked_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootPlan {
    Embedded,
    Ota {
        release_id: String,
        bytes: Vec<u8>,
        source_url: String,
        confirmed: bool,
    },
}

pub fn is_valid_release_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 || id.contains("..") {
        return false;
    }
    id.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn sanitize_value(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            '\r' | '\n' | '\0' => ' ',
            _ => c,
        })
        .collect()
}

fn parse_kv(raw: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim_end_matches('\r').to_string());
        }
    }
    map
}

pub fn parse_embedded_meta(raw: &str) -> EmbeddedMeta {
    let map = parse_kv(raw);
    EmbeddedMeta {
        version_code: map
            .get("version_code")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0),
        runtime_version: map.get("runtime_version").cloned().unwrap_or_default(),
        embedded_build_id: map.get("embedded_build_id").cloned().unwrap_or_default(),
        embedded_format: map
            .get("embedded_format")
            .cloned()
            .unwrap_or_else(|| "hbc".to_string()),
    }
}

impl OtaState {
    pub fn from_kv(raw: &str) -> Self {
        let map = parse_kv(raw);
        let read = |key: &str| map.get(key).cloned().unwrap_or_default();

        let active_id = read("active_id");
        let active = if !active_id.is_empty() {
            Some(BundleSlot {
                id: active_id,
                sha256: read("active_sha256"),
                format: read("active_format"),
                bundle_rel: read("active_bundle"),
                confirmed: read("active_confirmed") == "1",
                attempts: read("active_attempts").parse::<u32>().unwrap_or(0),
            })
        } else {
            None
        };

        let prev_id = read("prev_id");
        let prev = if !prev_id.is_empty() {
            Some(BundleSlot {
                id: prev_id,
                sha256: read("prev_sha256"),
                format: read("prev_format"),
                bundle_rel: read("prev_bundle"),
                confirmed: true,
                attempts: 0,
            })
        } else {
            None
        };

        let staged_id = read("staged_id");
        let staged = if !staged_id.is_empty() {
            Some(BundleSlot {
                id: staged_id,
                sha256: read("staged_sha256"),
                format: read("staged_format"),
                bundle_rel: read("staged_bundle"),
                confirmed: false,
                attempts: 0,
            })
        } else {
            None
        };

        let failed_ids = read("failed_ids")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect();

        Self {
            base_version_code: read("base_version_code").parse::<u64>().unwrap_or(0),
            runtime_version: read("runtime_version"),
            embedded_build_id: read("embedded_build_id"),
            active,
            prev,
            staged,
            failed_ids,
            last_rollback_reason: read("last_rollback_reason"),
            last_checked_at: read("last_checked_at").parse::<u64>().unwrap_or(0),
        }
    }

    pub fn to_kv(&self) -> String {
        let (aid, asha, afmt, abun, aconf, aatt) = match &self.active {
            Some(s) => (
                sanitize_value(&s.id),
                sanitize_value(&s.sha256),
                sanitize_value(&s.format),
                sanitize_value(&s.bundle_rel),
                if s.confirmed { "1" } else { "0" },
                s.attempts.to_string(),
            ),
            None => (
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                "0",
                "0".to_string(),
            ),
        };
        let (pid, psha, pfmt, pbun) = match &self.prev {
            Some(s) => (
                sanitize_value(&s.id),
                sanitize_value(&s.sha256),
                sanitize_value(&s.format),
                sanitize_value(&s.bundle_rel),
            ),
            None => (String::new(), String::new(), String::new(), String::new()),
        };
        let (sid, ssha, sfmt, sbun) = match &self.staged {
            Some(s) => (
                sanitize_value(&s.id),
                sanitize_value(&s.sha256),
                sanitize_value(&s.format),
                sanitize_value(&s.bundle_rel),
            ),
            None => (String::new(), String::new(), String::new(), String::new()),
        };

        format!(
            "schema=1\n\
             base_version_code={}\n\
             runtime_version={}\n\
             embedded_build_id={}\n\
             active_id={}\n\
             active_sha256={}\n\
             active_format={}\n\
             active_bundle={}\n\
             active_confirmed={}\n\
             active_attempts={}\n\
             prev_id={}\n\
             prev_sha256={}\n\
             prev_format={}\n\
             prev_bundle={}\n\
             staged_id={}\n\
             staged_sha256={}\n\
             staged_format={}\n\
             staged_bundle={}\n\
             failed_ids={}\n\
             last_rollback_reason={}\n\
             last_checked_at={}\n",
            self.base_version_code,
            sanitize_value(&self.runtime_version),
            sanitize_value(&self.embedded_build_id),
            aid,
            asha,
            afmt,
            abun,
            aconf,
            aatt,
            pid,
            psha,
            pfmt,
            pbun,
            sid,
            ssha,
            sfmt,
            sbun,
            sanitize_value(&self.failed_ids.join(",")),
            sanitize_value(&self.last_rollback_reason),
            self.last_checked_at,
        )
    }
}

pub fn ota_root_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("gpuix_ota")
}

fn state_file_path(ota_dir: &Path) -> PathBuf {
    ota_dir.join("state.kv")
}

fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("kv.tmp.{}", std::process::id()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

fn has_embedded_identity(embedded: &EmbeddedMeta) -> bool {
    embedded.version_code > 0 || !embedded.embedded_build_id.is_empty()
}

fn baseline_matches(state: &OtaState, embedded: &EmbeddedMeta) -> bool {
    state.base_version_code == embedded.version_code
        && state.runtime_version == embedded.runtime_version
        && state.embedded_build_id == embedded.embedded_build_id
}

fn reset_for_embedded(embedded: &EmbeddedMeta) -> OtaState {
    OtaState {
        base_version_code: embedded.version_code,
        runtime_version: embedded.runtime_version.clone(),
        embedded_build_id: embedded.embedded_build_id.clone(),
        ..OtaState::default()
    }
}

fn push_failed_id(list: &mut Vec<String>, id: &str) {
    if !is_valid_release_id(id) {
        return;
    }
    list.retain(|item| item != id);
    list.push(id.to_string());
    if list.len() > MAX_FAILED_IDS {
        let drop_count = list.len() - MAX_FAILED_IDS;
        list.drain(0..drop_count);
    }
}

fn validate_rel_bundle_path(ota_dir: &Path, rel: &str) -> std::result::Result<PathBuf, String> {
    if rel.is_empty() || rel.contains('\\') || !rel.starts_with("releases/") {
        return Err("invalid relative bundle path".to_string());
    }
    let rel_path = Path::new(rel);
    for comp in rel_path.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err("unsafe path component in bundle path".to_string()),
        }
    }
    Ok(ota_dir.join(rel_path))
}

fn verify_and_read_slot(ota_dir: &Path, slot: &BundleSlot) -> std::result::Result<Vec<u8>, String> {
    if !is_valid_release_id(&slot.id) {
        return Err(format!("invalid release id: {}", slot.id));
    }
    if slot.sha256.len() != 64 || !slot.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid sha256 digest in state".to_string());
    }
    let bundle_path = validate_rel_bundle_path(ota_dir, &slot.bundle_rel)?;
    let bytes = fs::read(&bundle_path).map_err(|err| format!("failed to read bundle: {err}"))?;
    if bytes.is_empty() {
        return Err("bundle file is empty".to_string());
    }
    let actual_sha = sha256_hex(&bytes);
    if !actual_sha.eq_ignore_ascii_case(&slot.sha256) {
        return Err(format!(
            "sha256 mismatch for {} (expected {}, got {actual_sha})",
            slot.id, slot.sha256
        ));
    }
    if slot.format == "hbc" {
        if bytes.len() < HERMES_BYTECODE_MAGIC.len()
            || bytes[..8] != HERMES_BYTECODE_MAGIC
        {
            return Err("invalid Hermes bytecode magic".to_string());
        }
    } else if slot.format != "js" {
        return Err(format!("unsupported bundle format: {}", slot.format));
    }
    Ok(bytes)
}

fn load_or_sync_state(ota_dir: &Path, embedded: &EmbeddedMeta) -> (OtaState, bool) {
    let state_path = state_file_path(ota_dir);
    let mut state = match fs::read_to_string(&state_path) {
        Ok(raw) => OtaState::from_kv(&raw),
        Err(_) => {
            let fresh = reset_for_embedded(embedded);
            return (fresh, true);
        }
    };
    if has_embedded_identity(embedded) && !baseline_matches(&state, embedded) {
        let _ = fs::remove_dir_all(ota_dir.join("releases"));
        let _ = fs::remove_dir_all(ota_dir.join("tmp"));
        state = reset_for_embedded(embedded);
        return (state, true);
    }
    (state, false)
}

fn save_state_best_effort(ota_dir: &Path, state: &OtaState) {
    let _ = write_atomic(&state_file_path(ota_dir), state.to_kv().as_bytes());
}

fn demote_active_to_prev_or_embedded(state: &mut OtaState, reason: &str) {
    if let Some(failed) = state.active.take() {
        push_failed_id(&mut state.failed_ids, &failed.id);
    }
    state.last_rollback_reason = sanitize_value(reason);
    if let Some(mut prev) = state.prev.take() {
        if !state.failed_ids.contains(&prev.id) {
            prev.confirmed = true;
            prev.attempts = 0;
            state.active = Some(prev);
        }
    }
}

/// Resolves which bundle cold boot should execute (`Embedded` vs verified `Ota`),
/// automatically rolling back invalid, APK-mismatched, or crash-looping releases.
pub fn resolve_boot_bundle(data_dir: &Path, embedded: &EmbeddedMeta) -> BootPlan {
    let ota_dir = ota_root_dir(data_dir);
    let (mut state, mut dirty) = load_or_sync_state(&ota_dir, embedded);

    for _attempt in 0..2 {
        let Some(active) = state.active.clone() else {
            if dirty {
                save_state_best_effort(&ota_dir, &state);
            }
            return BootPlan::Embedded;
        };

        if !is_valid_release_id(&active.id) {
            demote_active_to_prev_or_embedded(&mut state, "invalid active release id");
            dirty = true;
            continue;
        }
        if state.failed_ids.contains(&active.id) {
            demote_active_to_prev_or_embedded(&mut state, "release previously failed");
            dirty = true;
            continue;
        }
        if !active.confirmed && active.attempts >= MAX_UNCONFIRMED_LAUNCH_ATTEMPTS {
            let reason = format!(
                "crash-loop guard triggered for {} after {} unconfirmed attempts",
                active.id, active.attempts
            );
            demote_active_to_prev_or_embedded(&mut state, &reason);
            dirty = true;
            continue;
        }

        match verify_and_read_slot(&ota_dir, &active) {
            Ok(bytes) => {
                if !active.confirmed {
                    if let Some(slot) = state.active.as_mut() {
                        slot.attempts = slot.attempts.saturating_add(1);
                        dirty = true;
                    }
                }
                if dirty {
                    save_state_best_effort(&ota_dir, &state);
                }
                return BootPlan::Ota {
                    source_url: format!("ota:{}", active.id),
                    release_id: active.id,
                    bytes,
                    confirmed: active.confirmed,
                };
            }
            Err(err) => {
                demote_active_to_prev_or_embedded(&mut state, &err);
                dirty = true;
            }
        }
    }

    state.active = None;
    state.prev = None;
    save_state_best_effort(&ota_dir, &state);
    BootPlan::Embedded
}

/// Validates and reads the active OTA slot for in-process hot switching.
pub fn load_active_for_hot_apply(
    data_dir: &Path,
    embedded: &EmbeddedMeta,
) -> std::result::Result<(String, Vec<u8>, bool), String> {
    let ota_dir = ota_root_dir(data_dir);
    let (mut state, dirty) = load_or_sync_state(&ota_dir, embedded);
    if dirty {
        save_state_best_effort(&ota_dir, &state);
        return Err("OTA state was reset for updated APK baseline".to_string());
    }
    let Some(active) = state.active.clone() else {
        return Err("no active OTA release to apply".to_string());
    };
    if state.failed_ids.contains(&active.id) {
        demote_active_to_prev_or_embedded(&mut state, "release is in failed_ids");
        save_state_best_effort(&ota_dir, &state);
        return Err(format!("release {} is blocklisted", active.id));
    }
    match verify_and_read_slot(&ota_dir, &active) {
        Ok(bytes) => Ok((active.id, bytes, active.confirmed)),
        Err(err) => {
            demote_active_to_prev_or_embedded(&mut state, &err);
            save_state_best_effort(&ota_dir, &state);
            Err(err)
        }
    }
}

/// Reads the current `active` slot when Java already updated `state.kv` for rollback.
/// Returns `Ok(Some((id, bytes)))` if rolling back to `prev`, or `Ok(None)` for embedded APK bundle.
pub fn load_current_active_or_embedded(
    data_dir: &Path,
    embedded: &EmbeddedMeta,
) -> std::result::Result<Option<(String, Vec<u8>)>, String> {
    let ota_dir = ota_root_dir(data_dir);
    let (mut state, dirty) = load_or_sync_state(&ota_dir, embedded);
    if dirty {
        save_state_best_effort(&ota_dir, &state);
        return Ok(None);
    }
    let Some(active) = state.active.clone() else {
        return Ok(None);
    };
    match verify_and_read_slot(&ota_dir, &active) {
        Ok(bytes) => Ok(Some((active.id, bytes))),
        Err(err) => {
            state.active = None;
            state.prev = None;
            state.last_rollback_reason = sanitize_value(&err);
            save_state_best_effort(&ota_dir, &state);
            Ok(None)
        }
    }
}

/// Records an unconfirmed OTA runtime/eval failure and rolls back to `prev` (if valid) or `Embedded`.
pub fn record_unconfirmed_failure_and_rollback(
    data_dir: &Path,
    release_id: &str,
    reason: &str,
) -> Option<(String, Vec<u8>)> {
    let ota_dir = ota_root_dir(data_dir);
    let state_path = state_file_path(&ota_dir);
    let raw = fs::read_to_string(&state_path).ok()?;
    let mut state = OtaState::from_kv(&raw);

    let is_target_unconfirmed = state
        .active
        .as_ref()
        .is_some_and(|slot| slot.id == release_id && !slot.confirmed);
    if !is_target_unconfirmed {
        return None;
    }

    demote_active_to_prev_or_embedded(&mut state, reason);
    if let Some(prev_slot) = state.active.clone() {
        match verify_and_read_slot(&ota_dir, &prev_slot) {
            Ok(bytes) => {
                save_state_best_effort(&ota_dir, &state);
                return Some((prev_slot.id, bytes));
            }
            Err(_) => {
                state.active = None;
            }
        }
    }
    save_state_best_effort(&ota_dir, &state);
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gpuix_ota_test_{name}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_release_file(data_dir: &Path, id: &str, format: &str, bytes: &[u8]) -> BundleSlot {
        let rel = format!("releases/{id}/bundle.{format}");
        let path = ota_root_dir(data_dir).join(&rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        BundleSlot {
            id: id.to_string(),
            sha256: sha256_hex(bytes),
            format: format.to_string(),
            bundle_rel: rel,
            confirmed: false,
            attempts: 0,
        }
    }

    fn sample_embedded() -> EmbeddedMeta {
        EmbeddedMeta {
            version_code: 1,
            runtime_version: "1".to_string(),
            embedded_build_id: "a".repeat(64),
            embedded_format: "hbc".to_string(),
        }
    }

    #[test]
    fn sha256_matches_nist_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn kv_round_trip_preserves_fields_and_sanitizes_newlines() {
        let mut state = reset_for_embedded(&sample_embedded());
        state.active = Some(BundleSlot {
            id: "rel-2".to_string(),
            sha256: "f".repeat(64),
            format: "hbc".to_string(),
            bundle_rel: "releases/rel-2/bundle.hbc".to_string(),
            confirmed: true,
            attempts: 1,
        });
        state.failed_ids = vec!["rel-0".to_string(), "rel-1".to_string()];
        state.last_rollback_reason = "line1\nline2".to_string();
        state.last_checked_at = 1_700_000_000_000;

        let parsed = OtaState::from_kv(&state.to_kv());
        assert_eq!(parsed.base_version_code, 1);
        assert_eq!(parsed.active, state.active);
        assert_eq!(parsed.failed_ids, state.failed_ids);
        assert_eq!(parsed.last_rollback_reason, "line1 line2");
        assert_eq!(parsed.last_checked_at, 1_700_000_000_000);
    }

    #[test]
    fn release_id_blocks_path_traversal() {
        assert!(is_valid_release_id("v1.2.3-rc_1"));
        assert!(!is_valid_release_id(""));
        assert!(!is_valid_release_id("../evil"));
        assert!(!is_valid_release_id("a..b"));
        assert!(!is_valid_release_id("a/b"));
        assert!(!is_valid_release_id("a\\b"));
    }

    #[test]
    fn apk_upgrade_invalidates_prior_ota_state() {
        let dir = temp_dir("apk_upgrade");
        let emb1 = sample_embedded();
        let mut hbc = Vec::from(HERMES_BYTECODE_MAGIC);
        hbc.extend_from_slice(b"bundle-v1");
        let slot = write_release_file(&dir, "rel-1", "hbc", &hbc);
        let mut state = reset_for_embedded(&emb1);
        state.active = Some(slot);
        save_state_best_effort(&ota_root_dir(&dir), &state);

        let mut emb2 = emb1.clone();
        emb2.version_code = 2;
        let plan = resolve_boot_bundle(&dir, &emb2);
        assert_eq!(plan, BootPlan::Embedded);

        let reloaded = OtaState::from_kv(&fs::read_to_string(state_file_path(&ota_root_dir(&dir))).unwrap());
        assert_eq!(reloaded.base_version_code, 2);
        assert!(reloaded.active.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn crash_loop_guard_rolls_back_to_prev_then_embedded() {
        let dir = temp_dir("crash_loop");
        let emb = sample_embedded();

        let mut prev_hbc = Vec::from(HERMES_BYTECODE_MAGIC);
        prev_hbc.extend_from_slice(b"healthy-prev");
        let mut prev_slot = write_release_file(&dir, "rel-prev", "hbc", &prev_hbc);
        prev_slot.confirmed = true;

        let bad_slot = write_release_file(&dir, "rel-bad", "js", b"throw new Error('boom');");

        let mut state = reset_for_embedded(&emb);
        state.prev = Some(prev_slot.clone());
        state.active = Some(bad_slot);
        save_state_best_effort(&ota_root_dir(&dir), &state);

        // Attempt 1 and 2 are permitted for unconfirmed OTA.
        assert!(matches!(resolve_boot_bundle(&dir, &emb), BootPlan::Ota { ref release_id, .. } if release_id == "rel-bad"));
        assert!(matches!(resolve_boot_bundle(&dir, &emb), BootPlan::Ota { ref release_id, .. } if release_id == "rel-bad"));

        // Attempt 3 hits MAX_UNCONFIRMED_LAUNCH_ATTEMPTS (2) and rolls back to prev.
        match resolve_boot_bundle(&dir, &emb) {
            BootPlan::Ota { release_id, bytes, confirmed, .. } => {
                assert_eq!(release_id, "rel-prev");
                assert_eq!(bytes, prev_hbc);
                assert!(confirmed);
            }
            other => panic!("expected rollback to rel-prev, got {other:?}"),
        }

        let after = OtaState::from_kv(&fs::read_to_string(state_file_path(&ota_root_dir(&dir))).unwrap());
        assert!(after.failed_ids.contains(&"rel-bad".to_string()));

        // Confirmed prev remains stable across repeated launches.
        for _ in 0..4 {
            assert!(matches!(resolve_boot_bundle(&dir, &emb), BootPlan::Ota { ref release_id, .. } if release_id == "rel-prev"));
        }

        // Now corrupt rel-prev on disk -> falls back cleanly to Embedded.
        fs::write(ota_root_dir(&dir).join(&prev_slot.bundle_rel), b"tampered").unwrap();
        assert_eq!(resolve_boot_bundle(&dir, &emb), BootPlan::Embedded);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unconfirmed_hot_failure_rolls_back_immediately() {
        let dir = temp_dir("hot_fail");
        let emb = sample_embedded();
        let bad_slot = write_release_file(&dir, "rel-hot-bad", "js", b"broken");
        let mut state = reset_for_embedded(&emb);
        state.active = Some(bad_slot);
        save_state_best_effort(&ota_root_dir(&dir), &state);

        let fallback = record_unconfirmed_failure_and_rollback(&dir, "rel-hot-bad", "eval threw");
        assert!(fallback.is_none());
        assert_eq!(resolve_boot_bundle(&dir, &emb), BootPlan::Embedded);
        let after = OtaState::from_kv(&fs::read_to_string(state_file_path(&ota_root_dir(&dir))).unwrap());
        assert_eq!(after.failed_ids, vec!["rel-hot-bad".to_string()]);
        assert_eq!(after.last_rollback_reason, "eval threw");
        let _ = fs::remove_dir_all(&dir);
    }
}
