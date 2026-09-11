//! A small, dependency-free JSON reader and writer.
//!
//! ## Why this exists rather than a crate
//!
//! Tier 0 services parse exactly one shape of document: a flat-ish request body
//! whose financial fields are **decimal strings**. Pulling a general-purpose
//! parser and its transitive tree into the process that moves money buys
//! nothing here and adds a permanent supply chain (see the crate docs).
//!
//! ## The one rule
//!
//! [`Value`] has no floating-point variant. A JSON number arrives as the exact
//! text that was written, and it is the caller's job to interpret it — as an
//! integer, or by handing it to `Money::from_decimal_str`. There is no code
//! path in this module through which an amount can become an `f64`, because
//! there is no `f64` in it (P1, INV-001).
//!
//! Parsing is iterator-based rather than cursor-based so there is no index
//! arithmetic to get wrong, and every recursion is depth-limited.

use core::iter::Peekable;
use core::str::Chars;

/// Maximum nesting depth. A request body deeper than this is not a request
/// body, it is an attempt to exhaust the stack.
const MAX_DEPTH: u32 = 32;

/// A parsed JSON value.
///
/// Object keys keep their document order: a `Vec` of pairs, not a hash map,
/// so serialization is deterministic (INV-013) and iteration order is a fact
/// rather than a coincidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    /// `null`.
    Null,
    /// `true` / `false`.
    Bool(bool),
    /// A number, kept as the exact text that was written. Never a float.
    Number(String),
    /// A string, with escapes resolved.
    String(String),
    /// An array.
    Array(Vec<Value>),
    /// An object, in document order.
    Object(Vec<(String, Value)>),
}

impl Value {
    /// The value at `key`, if this is an object that has one.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// This value as a string, if it is one.
    ///
    /// A JSON number is deliberately **not** accepted here. An amount sent as a
    /// number has already lost exactness in the sender's JSON encoder; the edge
    /// rejects it rather than laundering it (P8).
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    /// This value as an `i64`, if it is a number that fits one.
    #[must_use]
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Number(text) => text.parse().ok(),
            _ => None,
        }
    }

    /// This value as a `u64`, if it is a number that fits one.
    #[must_use]
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Number(text) => text.parse().ok(),
            _ => None,
        }
    }

    /// This value as a bool, if it is one.
    #[must_use]
    pub const fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// The string field at `key`.
    #[must_use]
    pub fn str_field(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Self::as_str)
    }
}

/// Why a document could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JsonError {
    /// The document is not well-formed JSON.
    Malformed(&'static str),
    /// Nesting exceeded [`MAX_DEPTH`].
    TooDeep,
    /// Content followed the top-level value.
    TrailingContent,
}

impl core::fmt::Display for JsonError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Malformed(what) => write!(f, "malformed JSON: {what}"),
            Self::TooDeep => f.write_str("JSON nested too deeply"),
            Self::TrailingContent => f.write_str("trailing content after JSON value"),
        }
    }
}

/// Parse a complete JSON document.
///
/// # Errors
/// [`JsonError`] if the text is not one well-formed value.
pub fn parse(text: &str) -> Result<Value, JsonError> {
    let mut chars = text.chars().peekable();
    let value = parse_value(&mut chars, 0)?;
    skip_whitespace(&mut chars);
    if chars.peek().is_some() {
        return Err(JsonError::TrailingContent);
    }
    Ok(value)
}

fn skip_whitespace(chars: &mut Peekable<Chars<'_>>) {
    while let Some(c) = chars.peek() {
        if c.is_ascii_whitespace() {
            let _ = chars.next();
        } else {
            break;
        }
    }
}

fn deeper(depth: u32) -> Result<u32, JsonError> {
    depth
        .checked_add(1)
        .filter(|d| *d <= MAX_DEPTH)
        .ok_or(JsonError::TooDeep)
}

fn parse_value(chars: &mut Peekable<Chars<'_>>, depth: u32) -> Result<Value, JsonError> {
    skip_whitespace(chars);
    match chars.peek() {
        None => Err(JsonError::Malformed("unexpected end of input")),
        Some('{') => parse_object(chars, deeper(depth)?),
        Some('[') => parse_array(chars, deeper(depth)?),
        Some('"') => parse_string(chars).map(Value::String),
        Some('t') => literal(chars, "true", Value::Bool(true)),
        Some('f') => literal(chars, "false", Value::Bool(false)),
        Some('n') => literal(chars, "null", Value::Null),
        Some(_) => parse_number(chars),
    }
}

fn literal(
    chars: &mut Peekable<Chars<'_>>,
    word: &'static str,
    value: Value,
) -> Result<Value, JsonError> {
    for expected in word.chars() {
        if chars.next() != Some(expected) {
            return Err(JsonError::Malformed("bad literal"));
        }
    }
    Ok(value)
}

fn parse_object(chars: &mut Peekable<Chars<'_>>, depth: u32) -> Result<Value, JsonError> {
    let _ = chars.next(); // '{'
    let mut fields: Vec<(String, Value)> = Vec::new();
    skip_whitespace(chars);
    if chars.peek() == Some(&'}') {
        let _ = chars.next();
        return Ok(Value::Object(fields));
    }
    loop {
        skip_whitespace(chars);
        let key = parse_string(chars)?;
        skip_whitespace(chars);
        if chars.next() != Some(':') {
            return Err(JsonError::Malformed("expected ':' after object key"));
        }
        let value = parse_value(chars, depth)?;
        // A repeated key is ambiguous; last-wins is a silent choice, so the
        // first binding stands and the duplicate is refused outright.
        if fields.iter().any(|(k, _)| *k == key) {
            return Err(JsonError::Malformed("duplicate object key"));
        }
        fields.push((key, value));
        skip_whitespace(chars);
        match chars.next() {
            Some(',') => {}
            Some('}') => return Ok(Value::Object(fields)),
            _ => return Err(JsonError::Malformed("expected ',' or '}'")),
        }
    }
}

fn parse_array(chars: &mut Peekable<Chars<'_>>, depth: u32) -> Result<Value, JsonError> {
    let _ = chars.next(); // '['
    let mut items: Vec<Value> = Vec::new();
    skip_whitespace(chars);
    if chars.peek() == Some(&']') {
        let _ = chars.next();
        return Ok(Value::Array(items));
    }
    loop {
        items.push(parse_value(chars, depth)?);
        skip_whitespace(chars);
        match chars.next() {
            Some(',') => {}
            Some(']') => return Ok(Value::Array(items)),
            _ => return Err(JsonError::Malformed("expected ',' or ']'")),
        }
    }
}

fn parse_string(chars: &mut Peekable<Chars<'_>>) -> Result<String, JsonError> {
    if chars.next() != Some('"') {
        return Err(JsonError::Malformed("expected a string"));
    }
    let mut out = String::new();
    loop {
        match chars.next() {
            None => return Err(JsonError::Malformed("unterminated string")),
            Some('"') => return Ok(out),
            Some('\\') => match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('/') => out.push('/'),
                Some('b') => out.push('\u{8}'),
                Some('f') => out.push('\u{c}'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('u') => out.push(parse_unicode_escape(chars)?),
                _ => return Err(JsonError::Malformed("bad string escape")),
            },
            // Control characters must be escaped in JSON.
            Some(c) if (c as u32) < 0x20 => {
                return Err(JsonError::Malformed("raw control character in string"))
            }
            Some(c) => out.push(c),
        }
    }
}

fn parse_unicode_escape(chars: &mut Peekable<Chars<'_>>) -> Result<char, JsonError> {
    let mut code: u32 = 0;
    for _ in 0..4 {
        let digit = chars
            .next()
            .and_then(|c| c.to_digit(16))
            .ok_or(JsonError::Malformed("bad \\u escape"))?;
        code = code
            .checked_mul(16)
            .and_then(|c| c.checked_add(digit))
            .ok_or(JsonError::Malformed("bad \\u escape"))?;
    }
    // Surrogate halves are not scalar values. Rather than silently substituting
    // U+FFFD, the document is refused: a mangled identifier is worse than a
    // rejected request.
    char::from_u32(code).ok_or(JsonError::Malformed("\\u escape is not a scalar value"))
}

fn parse_number(chars: &mut Peekable<Chars<'_>>) -> Result<Value, JsonError> {
    let mut text = String::new();
    while let Some(c) = chars.peek() {
        if c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | 'e' | 'E') {
            if let Some(c) = chars.next() {
                text.push(c);
            }
        } else {
            break;
        }
    }
    if !is_json_number(&text) {
        return Err(JsonError::Malformed("expected a number"));
    }
    Ok(Value::Number(text))
}

/// Whether `text` is a JSON number exactly as the grammar defines one.
///
/// Written out rather than approximated, because a lax number parser accepts
/// `1.2.3` and then hands it to something that reads only the first part. This
/// runs on characters, so there is no index arithmetic and no slicing.
fn is_json_number(text: &str) -> bool {
    let mut chars = text.chars().peekable();
    if chars.peek() == Some(&'-') {
        let _ = chars.next();
    }
    // int: '0' | [1-9][0-9]*   — a leading zero may not be followed by digits.
    match chars.next() {
        Some('0') => {}
        Some(c) if c.is_ascii_digit() => {
            while chars.peek().is_some_and(char::is_ascii_digit) {
                let _ = chars.next();
            }
        }
        _ => return false,
    }
    // frac: '.' [0-9]+
    if chars.peek() == Some(&'.') {
        let _ = chars.next();
        if !chars.peek().is_some_and(char::is_ascii_digit) {
            return false;
        }
        while chars.peek().is_some_and(char::is_ascii_digit) {
            let _ = chars.next();
        }
    }
    // exp: [eE] [+-]? [0-9]+
    if matches!(chars.peek(), Some('e' | 'E')) {
        let _ = chars.next();
        if matches!(chars.peek(), Some('+' | '-')) {
            let _ = chars.next();
        }
        if !chars.peek().is_some_and(char::is_ascii_digit) {
            return false;
        }
        while chars.peek().is_some_and(char::is_ascii_digit) {
            let _ = chars.next();
        }
    }
    chars.peek().is_none()
}

/// Escape a string for inclusion in a JSON document.
///
/// Every service in this repository writes JSON by `format!`, which is fine for
/// fixed shapes and dangerous for anything a caller supplied. Any value that
/// came from outside goes through here first.
#[must_use]
pub fn escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn reads_a_flat_order_body() {
        let value =
            parse(r#"{"account":"50000001","symbol":"EURUSD","side":"BUY","volume":"0.10"}"#)
                .unwrap();
        assert_eq!(value.str_field("account"), Some("50000001"));
        assert_eq!(value.str_field("symbol"), Some("EURUSD"));
        assert_eq!(value.str_field("side"), Some("BUY"));
        assert_eq!(value.str_field("volume"), Some("0.10"));
    }

    /// A number keeps its exact text. Nothing in this module can turn it into a
    /// float, which is the whole point (INV-001).
    #[test]
    fn a_number_keeps_its_exact_text() {
        let value = parse(r#"{"n":0.1000000000000000055511151231257827}"#).unwrap();
        assert_eq!(
            value.get("n"),
            Some(&Value::Number(
                "0.1000000000000000055511151231257827".to_owned()
            ))
        );
        // And it is not reachable as a string, so it cannot be mistaken for a
        // validated decimal amount.
        assert_eq!(value.str_field("n"), None);
    }

    #[test]
    fn object_order_is_preserved() {
        let value = parse(r#"{"b":"1","a":"2"}"#).unwrap();
        let Value::Object(fields) = value else {
            panic!("expected an object");
        };
        assert_eq!(fields[0].0, "b");
        assert_eq!(fields[1].0, "a");
    }

    #[test]
    fn rejects_malformed_documents() {
        for bad in [
            "",
            "{",
            "{\"a\":}",
            "{\"a\":1,}",
            "[1,]",
            "{\"a\":1}{",
            "{\"a\":1,\"a\":2}",
            "tru",
            "\"unterminated",
        ] {
            assert!(parse(bad).is_err(), "should have rejected: {bad}");
        }
    }

    #[test]
    fn rejects_documents_nested_past_the_limit() {
        let deep = format!("{}{}", "[".repeat(64), "]".repeat(64));
        assert_eq!(parse(&deep), Err(JsonError::TooDeep));
    }

    #[test]
    fn escapes_round_trip() {
        let raw = "quote \" backslash \\ newline \n tab \t";
        let document = format!(r#"{{"v":"{}"}}"#, escape(raw));
        assert_eq!(parse(&document).unwrap().str_field("v"), Some(raw));
    }

    #[test]
    fn resolves_escapes_when_reading() {
        let value = parse(r#"{"v":"a\u0041b\nc"}"#).unwrap();
        assert_eq!(value.str_field("v"), Some("aAb\nc"));
    }

    #[test]
    fn rejects_numbers_the_grammar_does_not_allow() {
        for bad in [
            "{\"n\":1.2.3}",
            "{\"n\":01}",
            "{\"n\":1e}",
            "{\"n\":-}",
            "{\"n\":.5}",
        ] {
            assert!(parse(bad).is_err(), "should have rejected: {bad}");
        }
        for good in [
            "{\"n\":0}",
            "{\"n\":-12}",
            "{\"n\":1.5}",
            "{\"n\":2e10}",
            "{\"n\":-3.25E-4}",
        ] {
            assert!(parse(good).is_ok(), "should have accepted: {good}");
        }
    }

    #[test]
    fn nested_values_are_reachable() {
        let value = parse(r#"{"outer":{"inner":["x","y"]}}"#).unwrap();
        let inner = value.get("outer").and_then(|o| o.get("inner")).unwrap();
        assert_eq!(
            inner,
            &Value::Array(vec![
                Value::String("x".to_owned()),
                Value::String("y".to_owned()),
            ])
        );
    }
}
