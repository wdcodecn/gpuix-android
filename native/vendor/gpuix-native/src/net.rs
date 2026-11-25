//! Native HTTP client bridge exposed to Hermes JS via N-API `AsyncTask`.
//!
//! Reuses Zed's `gpui::http_client` + `reqwest_client` (rustls TLS + connection
//! pooling) without introducing any extra networking or TLS crate.

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use napi::bindgen_prelude::{AsyncTask, Env, Error, Result, Task};
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use napi_derive::napi;
use serde::{Deserialize, Serialize};
#[cfg(all(
    not(all(target_arch = "wasm32", target_os = "unknown")),
    feature = "http-client"
))]
use std::sync::{Arc, OnceLock};

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<Vec<(String, String)>>,
    #[serde(default)]
    pub body_text: Option<String>,
    #[serde(default)]
    pub body_base64: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub redirect: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchResponse {
    pub status: u16,
    pub ok: bool,
    pub headers: Vec<(String, String)>,
    pub body_base64: String,
    pub url: String,
}

#[cfg(all(
    not(all(target_arch = "wasm32", target_os = "unknown")),
    feature = "http-client"
))]
static HTTP_CLIENT: OnceLock<std::result::Result<Arc<reqwest_client::ReqwestClient>, String>> =
    OnceLock::new();

#[cfg(all(
    not(all(target_arch = "wasm32", target_os = "unknown")),
    feature = "http-client"
))]
fn shared_http_client() -> std::result::Result<&'static Arc<reqwest_client::ReqwestClient>, String> {
    let entry = HTTP_CLIENT.get_or_init(|| {
        reqwest_client::ReqwestClient::user_agent("GPUIX/1.0")
            .map(Arc::new)
            .map_err(|err| format!("Failed to initialize HTTP client: {err}"))
    });
    match entry {
        Ok(client) => Ok(client),
        Err(err) => Err(err.clone()),
    }
}

#[cfg(all(
    not(all(target_arch = "wasm32", target_os = "unknown")),
    feature = "http-client"
))]
fn execute_fetch(request_json: &str) -> std::result::Result<String, String> {
    use base64::Engine as _;
    use futures::AsyncReadExt as _;
    use gpui::http_client::{http, AsyncBody, HttpClient as _, HttpRequestExt as _, RedirectPolicy};

    let req: FetchRequest =
        serde_json::from_str(request_json).map_err(|err| format!("Invalid fetch request: {err}"))?;
    let method_str = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let method = http::Method::from_bytes(method_str.as_bytes())
        .map_err(|err| format!("Invalid HTTP method '{method_str}': {err}"))?;

    let mut builder = http::Request::builder().method(method).uri(&req.url);
    if let Some(headers) = &req.headers {
        for (name, value) in headers {
            if let (Ok(hname), Ok(hval)) = (
                http::header::HeaderName::from_bytes(name.as_bytes()),
                http::header::HeaderValue::from_str(value),
            ) {
                builder = builder.header(hname, hval);
            }
        }
    }

    let redirect = match req.redirect.as_deref() {
        Some("manual") => RedirectPolicy::NoFollow,
        _ => RedirectPolicy::FollowLimit(10),
    };
    builder = builder.follow_redirects(redirect);

    if let Some(ms) = req.timeout_ms {
        if ms > 0 {
            builder = builder.timeout(std::time::Duration::from_millis(ms));
        }
    }

    let body = if let Some(b64) = &req.body_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|err| format!("Invalid bodyBase64: {err}"))?;
        AsyncBody::from(bytes)
    } else if let Some(text) = &req.body_text {
        AsyncBody::from(text.clone())
    } else {
        AsyncBody::empty()
    };

    let http_req = builder
        .body(body)
        .map_err(|err| format!("Failed to build HTTP request: {err}"))?;
    let client = shared_http_client()?;

    let (parts, body_bytes) = futures::executor::block_on(async move {
        let mut resp = client.send(http_req).await?;
        let mut buf = Vec::new();
        resp.body_mut().read_to_end(&mut buf).await?;
        anyhow::Ok((resp.into_parts().0, buf))
    })
    .map_err(|err| format!("{err:#}"))?;

    let status = parts.status.as_u16();
    let headers = parts
        .headers
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let payload = FetchResponse {
        status,
        ok: (200..300).contains(&status),
        headers,
        body_base64: base64::engine::general_purpose::STANDARD.encode(&body_bytes),
        url: req.url,
    };
    serde_json::to_string(&payload).map_err(|err| format!("Failed to serialize response: {err}"))
}

#[cfg(all(
    not(all(target_arch = "wasm32", target_os = "unknown")),
    not(feature = "http-client")
))]
fn execute_fetch(_request_json: &str) -> std::result::Result<String, String> {
    Err("nativeFetch requires the 'http-client' Cargo feature".to_string())
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub struct FetchTask {
    pub request_json: String,
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[napi]
impl Task for FetchTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        execute_fetch(&self.request_json).map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) fn spawn_fetch_task(request_json: String) -> AsyncTask<FetchTask> {
    AsyncTask::new(FetchTask { request_json })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fetch_request_camel_case_fields() {
        let json = r#"{
            "url": "https://example.com/api",
            "method": "POST",
            "headers": [["Content-Type", "application/json"]],
            "bodyText": "{\"hello\":1}",
            "timeoutMs": 5000,
            "redirect": "manual"
        }"#;
        let req: FetchRequest = serde_json::from_str(json).expect("valid request");
        assert_eq!(req.url, "https://example.com/api");
        assert_eq!(req.method.as_deref(), Some("POST"));
        assert_eq!(
            req.headers,
            Some(vec![(
                "Content-Type".to_string(),
                "application/json".to_string()
            )])
        );
        assert_eq!(req.body_text.as_deref(), Some("{\"hello\":1}"));
        assert_eq!(req.timeout_ms, Some(5000));
        assert_eq!(req.redirect.as_deref(), Some("manual"));
    }

    #[test]
    fn serializes_fetch_response_with_base64_and_ok_flag() {
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"ok-bytes");
        let resp = FetchResponse {
            status: 201,
            ok: true,
            headers: vec![("x-test".to_string(), "1".to_string())],
            body_base64: encoded.clone(),
            url: "https://example.com".to_string(),
        };
        let raw = serde_json::to_string(&resp).expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse");
        assert_eq!(parsed["status"], 201);
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["bodyBase64"], encoded);
        assert_eq!(parsed["headers"][0][0], "x-test");
    }

    #[test]
    fn rejects_malformed_request_json_or_missing_feature_gracefully() {
        let err = execute_fetch("{not-json}").expect_err("malformed json must error");
        assert!(
            err.contains("Invalid fetch request") || err.contains("http-client"),
            "unexpected error: {err}"
        );
    }
}
