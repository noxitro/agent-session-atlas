//! serve の HTTP の下回り: 要求の URL の読み方(Node の `new URL(req.url, 'http://127.0.0.1')` と decodeURIComponent に合わせる)、
//! 本文の読み方(上限を超えても最後まで読み捨ててから 413)、応答の形、ほかのサーバに尋ねる小さなクライアント。

use super::HttpError;
use bytes::Bytes;
use http_body_util::BodyExt;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

// ---------- URL ----------

/// 要求の URL のうち、使うところ(pathname と searchParams)
#[derive(Debug, Clone, PartialEq)]
pub struct ReqUrl {
    pub path: String,
    pub query: Vec<(String, String)>,
}

impl ReqUrl {
    /// searchParams.get(最初のもの)
    pub fn param(&self, key: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

/// WHATWG URL の path percent-encode set(C0 制御文字・空白・" # < > ? ` { } と ASCII 外)
fn encode_path_byte(b: u8, out: &mut String) {
    if b <= 0x20 || b >= 0x7f || matches!(b, b'"' | b'#' | b'<' | b'>' | b'?' | b'`' | b'{' | b'}') {
        out.push_str(&format!("%{b:02X}"));
    } else {
        out.push(b as char);
    }
}

fn is_single_dot(s: &str) -> bool {
    s == "." || s.eq_ignore_ascii_case("%2e")
}

fn is_double_dot(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    matches!(l.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e")
}

/// `new URL(target, 'http://127.0.0.1')` の pathname と searchParams。\ は / として扱い、. と ..(%2e も)の区切りを畳む
pub fn parse_request_target(target: &str) -> ReqUrl {
    let target = target.split('#').next().unwrap_or("");
    let (path, query) = match target.find('?') {
        Some(i) => (&target[..i], Some(&target[i + 1..])),
        None => (target, None),
    };
    let mut path = path.replace('\\', "/");
    // //host/… はホストを含む形(パスは次の / から)
    if let Some(rest) = path.strip_prefix("//") {
        path = match rest.find('/') {
            Some(i) => rest[i..].to_string(),
            None => "/".to_string(),
        };
    }
    let input = path.strip_prefix('/').unwrap_or(&path);
    let segs: Vec<&str> = input.split('/').collect();
    let mut out: Vec<String> = Vec::new();
    for (i, seg) in segs.iter().enumerate() {
        let last = i + 1 == segs.len();
        if is_double_dot(seg) {
            out.pop();
            if last {
                out.push(String::new());
            }
        } else if is_single_dot(seg) {
            if last {
                out.push(String::new());
            }
        } else {
            let mut e = String::new();
            for b in seg.bytes() {
                encode_path_byte(b, &mut e);
            }
            out.push(e);
        }
    }
    ReqUrl { path: format!("/{}", out.join("/")), query: query.map(parse_query).unwrap_or_default() }
}

/// application/x-www-form-urlencoded の解釈(URLSearchParams)
fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (form_decode(k), form_decode(v))
        })
        .collect()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match (hex_val(b[i + 1]), hex_val(b[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push(h * 16 + l);
                        i += 3;
                        continue;
                    }
                    _ => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// JS の decodeURIComponent。% の後が 16 進 2 桁でない・UTF-8 として正しくない並びはエラー(URIError)
pub fn decode_uri_component(s: &str) -> Result<String, ()> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    let byte_at = |i: usize| -> Result<u8, ()> {
        if b.get(i) != Some(&b'%') || i + 2 >= b.len() {
            return Err(());
        }
        Ok(hex_val(*b.get(i + 1).ok_or(())?).ok_or(())? * 16 + hex_val(*b.get(i + 2).ok_or(())?).ok_or(())?)
    };
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let first = byte_at(i)?;
        i += 3;
        if first < 0x80 {
            out.push(first);
            continue;
        }
        let n = match first {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return Err(()),
        };
        let mut seq = vec![first];
        for _ in 1..n {
            let c = byte_at(i)?;
            if c & 0xc0 != 0x80 {
                return Err(());
            }
            seq.push(c);
            i += 3;
        }
        std::str::from_utf8(&seq).map_err(|_| ())?;
        out.extend_from_slice(&seq);
    }
    String::from_utf8(out).map_err(|_| ())
}

// ---------- 要求と応答 ----------

/// Node が重ねて届いたときに最初のものだけ使う見出し(それ以外は ", " でつなぐ)
const SINGLE_HEADERS: [&str; 18] = [
    "age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host", "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer", "retry-after", "server", "user-agent",
];

/// 要求の見出し(Node の req.headers[name] と同じ値)
pub fn header(h: &hyper::HeaderMap, name: &str) -> Option<String> {
    let mut vals = h.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
    let first = vals.next()?;
    if SINGLE_HEADERS.contains(&name) {
        return Some(first);
    }
    Some(std::iter::once(first).chain(vals).collect::<Vec<_>>().join(", "))
}

/// 本文を後から読む口(処理の途中で、要る所で読む。読む前に断る要求は本文を読まない)
pub struct BodyReader {
    body: Option<hyper::body::Incoming>,
    rt: tokio::runtime::Handle,
}

impl BodyReader {
    pub fn new(body: hyper::body::Incoming, rt: tokio::runtime::Handle) -> Self {
        BodyReader { body: Some(body), rt }
    }

    /// 上限を超えても最後まで読み捨ててから 413 にする(途中で打ち切ると送信中の相手が応答を受け取れず止まる)
    pub fn read(&mut self, limit: u64) -> Result<Vec<u8>, HttpError> {
        let Some(mut body) = self.body.take() else { return Ok(Vec::new()) };
        let r: Result<(Vec<u8>, u64), hyper::Error> = self.rt.block_on(async move {
            let mut kept: Vec<u8> = Vec::new();
            let mut size: u64 = 0;
            while let Some(frame) = body.frame().await {
                if let Ok(data) = frame?.into_data() {
                    size += data.len() as u64;
                    if size <= limit {
                        kept.extend_from_slice(&data);
                    }
                }
            }
            Ok((kept, size))
        });
        let (kept, size) = r.map_err(|e| HttpError::new(400, format!("本文を読めません: {e}")))?;
        if size > limit {
            return Err(HttpError::new(413, "本文が大きすぎます"));
        }
        Ok(kept)
    }
}

/// 応答(見出しは並べた順に出す)
#[derive(Debug, Clone)]
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Bytes,
}

/// 応答が送り終わる(か相手が切る)まで持ち歩く印。落ちたときに知らせる
pub struct Settle(pub Option<Box<dyn FnOnce() + Send>>);

impl Drop for Settle {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

/// 送り終わる(か相手が切る)まで印を持つ本文
pub struct SettleBody {
    inner: http_body_util::Full<Bytes>,
    _settle: Settle,
}

impl SettleBody {
    pub fn new(b: Bytes, settle: Settle) -> Self {
        SettleBody { inner: http_body_util::Full::new(b), _settle: settle }
    }
}

impl http_body::Body for SettleBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        std::pin::Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

// ---------- ほかのサーバに尋ねる ----------

/// GET の応答の見出し(小文字の名前と値)と状態コード
pub struct SimpleResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl SimpleResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// 127.0.0.1 のサーバに 1 回だけ要求を送る(Connection: close。timeout を過ぎたら失敗)
pub fn simple_request(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8], timeout: Duration) -> std::io::Result<SimpleResponse> {
    let deadline = Instant::now() + timeout;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = std::net::TcpStream::connect_timeout(&addr, timeout)?;
    s.set_nodelay(true)?;
    let left = || deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
    s.set_write_timeout(Some(left()))?;
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())?;
    s.write_all(body)?;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "時間切れ"));
        }
        s.set_read_timeout(Some(left()))?;
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    parse_response(&buf).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "応答を読めません"))
}

fn parse_response(buf: &[u8]) -> Option<SimpleResponse> {
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..end]);
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))).collect();
    let raw = &buf[end + 4..];
    let chunked = headers.iter().any(|(k, v)| k == "transfer-encoding" && v.eq_ignore_ascii_case("chunked"));
    let body = if chunked { dechunk(raw) } else { raw.to_vec() };
    Some(SimpleResponse { status, headers, body })
}

fn dechunk(mut raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(i) = raw.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(String::from_utf8_lossy(&raw[..i]).split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        raw = &raw[i + 2..];
        if size == 0 || raw.len() < size {
            break;
        }
        out.extend_from_slice(&raw[..size]);
        raw = raw.get(size + 2..).unwrap_or(&[]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_like_node() {
        let p = |t: &str| parse_request_target(t).path;
        assert_eq!(p("/"), "/");
        assert_eq!(p("/sessions/"), "/sessions/");
        assert_eq!(p("/../secret.txt"), "/secret.txt");
        assert_eq!(p("/%2e%2e/secret.txt"), "/secret.txt");
        assert_eq!(p("/a/%2E/b"), "/a/b");
        assert_eq!(p("/a/.."), "/");
        assert_eq!(p("/..%2Fsecret.txt"), "/..%2Fsecret.txt");
        assert_eq!(p("/api/memos/.."), "/api/");
        assert_eq!(p("/a\\..\\b"), "/b");
        assert_eq!(p("//host/x"), "/x");
        assert_eq!(p("/a b"), "/a%20b");
        let u = parse_request_target("/view/s1?kind=full&kind=x&target=a+b%21");
        assert_eq!(u.param("kind"), Some("full"));
        assert_eq!(u.param("target"), Some("a b!"));
        assert_eq!(u.param("none"), None);
    }

    #[test]
    fn decode_like_js() {
        assert_eq!(decode_uri_component("a%2Fb").unwrap(), "a/b");
        assert_eq!(decode_uri_component("%E3%81%82").unwrap(), "あ");
        assert!(decode_uri_component("%E0%A4%A").is_err());
        assert!(decode_uri_component("%").is_err());
        assert!(decode_uri_component("%zz").is_err());
        assert!(decode_uri_component("%C0%80").is_err());
        assert!(decode_uri_component("%ED%A0%80").is_err());
        assert_eq!(decode_uri_component("+x").unwrap(), "+x");
    }
}
