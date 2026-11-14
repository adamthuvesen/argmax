use std::time::Duration;

use serde_json::Value;

/// Runs on a blocking thread: `read_off_main` calls the remaining-usage fetch.
pub fn get_json(
    url: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<(u16, Value), String> {
    crate::util::tls::install_crypto_provider();
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    if body.trim().is_empty() {
        return Ok((status, Value::Null));
    }
    match serde_json::from_str(&body) {
        Ok(value) => Ok((status, value)),
        Err(_) => Ok((status, Value::String(body))),
    }
}
