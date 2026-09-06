use std::time::Duration;

use serde_json::Value;

pub fn get_json(
    url: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<(u16, Value), String> {
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let mut request = agent.get(url);
    for (name, value) in headers {
        request = request.set(name, value);
    }
    match request.call() {
        Ok(response) => read_response(response.status(), response),
        Err(ureq::Error::Status(code, response)) => read_response(code, response),
        Err(error) => Err(error.to_string()),
    }
}

fn read_response(status: u16, response: ureq::Response) -> Result<(u16, Value), String> {
    let body = response.into_string().unwrap_or_default();
    if body.trim().is_empty() {
        return Ok((status, Value::Null));
    }
    match serde_json::from_str(&body) {
        Ok(value) => Ok((status, value)),
        Err(_) => Ok((status, Value::String(body))),
    }
}
