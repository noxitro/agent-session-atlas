//! serve の HTTP の下回り: 要求の URL の読み方(Node の `new URL(req.url, 'http://127.0.0.1')` と decodeURIComponent に合わせる)、
//! 本文の読み方(上限を超えても最後まで読み捨ててから 413)、応答の形、接続ごとの HTTP/1.1 の読み書き(標準ライブラリだけ)、
//! ほかのサーバに尋ねる小さなクライアント。

use super::HttpError;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
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

/// 要求の見出し(名前は小文字、値は届いた順)
pub type Headers = Vec<(String, String)>;

/// 要求の見出し(Node の req.headers[name] と同じ値)
pub fn header(h: &[(String, String)], name: &str) -> Option<String> {
    let mut vals = h.iter().filter(|(k, _)| k == name).map(|(_, v)| v.clone());
    let first = vals.next()?;
    if SINGLE_HEADERS.contains(&name) {
        return Some(first);
    }
    Some(std::iter::once(first).chain(vals).collect::<Vec<_>>().join(", "))
}

/// 本文を後から読む口(処理の途中で、要る所で読む。読む前に断る要求は本文を読まない)
pub struct BodyReader {
    stream: Option<TcpStream>,
    /// 見出しと一緒に読んでしまった本文の頭
    pre: Vec<u8>,
    /// まだ読んでいない本文の大きさ(pre を含む)
    remaining: u64,
    /// Expect: 100-continue で、まだ 100 を返していない(読むときに返す)
    continue_pending: bool,
    taken: bool,
    /// 読んでいる途中で失敗した(この接続は続けて使えない)
    broken: bool,
}

impl BodyReader {
    /// 上限を超えても最後まで読み捨ててから 413 にする(途中で打ち切ると送信中の相手が応答を受け取れず止まる)
    pub fn read(&mut self, limit: u64) -> Result<Vec<u8>, HttpError> {
        if self.taken {
            return Ok(Vec::new());
        }
        self.taken = true;
        let mut kept: Vec<u8> = Vec::new();
        let mut size: u64 = 0;
        let r = self.consume(|data| {
            size += data.len() as u64;
            if size <= limit {
                kept.extend_from_slice(data);
            }
        });
        if let Err(e) = r {
            return Err(HttpError::new(400, format!("本文を読めません: {e}")));
        }
        if size > limit {
            return Err(HttpError::new(413, "本文が大きすぎます"));
        }
        Ok(kept)
    }

    /// 残りの本文を読み、読んだ分を渡す。失敗したら broken にする
    fn consume(&mut self, mut f: impl FnMut(&[u8])) -> std::io::Result<()> {
        let pre = std::mem::take(&mut self.pre);
        if !pre.is_empty() {
            self.remaining -= pre.len() as u64;
            f(&pre);
        }
        if self.remaining == 0 {
            return Ok(());
        }
        let r = self.consume_stream(&mut f);
        if r.is_err() {
            self.broken = true;
        }
        r
    }

    fn consume_stream(&mut self, f: &mut impl FnMut(&[u8])) -> std::io::Result<()> {
        let Some(s) = self.stream.as_mut() else { return Err(std::io::Error::other("接続がありません")) };
        if self.continue_pending {
            self.continue_pending = false;
            s.set_write_timeout(Some(IO_TIMEOUT))?;
            s.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
        }
        s.set_read_timeout(Some(IO_TIMEOUT))?;
        let mut chunk = vec![0u8; 64 * 1024];
        while self.remaining > 0 {
            let want = chunk.len().min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
            match s.read(&mut chunk[..want]) {
                Ok(0) => return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "本文の途中で接続が切れました")),
                Ok(n) => {
                    self.remaining -= n as u64;
                    f(&chunk[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// 処理が読まなかった本文を、次の要求のために読み捨てられるか(読み捨てられないなら接続を切る)
    fn can_drain(&self) -> bool {
        !self.broken && (self.remaining == 0 || (!self.continue_pending && self.remaining <= DRAIN_MAX))
    }
}

/// 応答(見出しは並べた順に出す)
#[derive(Debug, Clone)]
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

/// 届いた要求(本文は後から読む)
pub struct Request {
    pub method: String,
    /// 要求行の対象(絶対形式 http://host/… は path と query だけにしたもの)
    pub target: String,
    pub headers: Headers,
    pub body: BodyReader,
}

// ---------- 接続 ----------
//
// 127.0.0.1 の 1 人だけが使うサーバなので、標準ライブラリだけで HTTP/1.1 を話す(接続ごとに 1 本のスレッド)。
// 外から見える形(状態コード・見出し・keep-alive・HEAD・Expect: 100-continue・壊れた要求への 400/431)は、前に使っていた hyper に合わせている。
// 本文の chunked は受けない(画面と CLI は Content-Length で送る)。Transfer-Encoding の付いた要求は 400 で断る。

/// 見出し(要求行と見出しの行)の大きさの上限(hyper の既定と同じくらい。超えたら 431)
const HEAD_MAX: usize = 400 * 1024;
/// 見出しの数の上限(hyper の既定と同じ。超えたら 431)
const HEADERS_MAX: usize = 100;
/// 使い終わった接続で次の要求を待つ時間。ブラウザは使った接続を数分は取っておくので、それより長く待つ
/// (先に切ると、送りかけた要求をブラウザが送り直すことになる)。待ちきれなければ切り、スレッドを残さない
const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// 要求の途中(見出しの続き・本文)と応答の書き込みで、相手が止まったときに待つ時間
const IO_TIMEOUT: Duration = Duration::from_secs(60);
/// 処理が読まずに断った要求の本文を、接続を使い続けるために読み捨てる上限(超えたら接続を切る)
const DRAIN_MAX: u64 = 16 * 1024 * 1024;

/// 見出しを読めなかったとき
enum HeadError {
    /// 相手が切った・待ちきれなかった(何も返さずに切る)
    Gone,
    /// 壊れた要求(この状態コードを返して切る)
    Status(u16),
}

/// 読んだ見出し
struct Head {
    method: String,
    target: String,
    /// HTTP/1.x の x
    minor: u8,
    headers: Headers,
}

/// 1 本の接続で要求を順に受ける(keep-alive)。begin は要求を受けてから応答を書き終えるまで持つ印を返す
/// (落とすと「応えている途中」の数から外れる)。handle は応答と、読み終えた(または読まなかった)本文の口を返す
pub fn serve_conn<G>(stream: TcpStream, begin: impl Fn() -> G, handle: impl Fn(Request) -> (Resp, BodyReader)) {
    let mut s = stream;
    let mut reader = s.try_clone().ok();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let head = match read_head(&mut s, &mut buf) {
            Ok(h) => h,
            Err(HeadError::Gone) => return,
            Err(HeadError::Status(code)) => {
                let _ = write_error(&mut s, code);
                close_gently(&mut s);
                return;
            }
        };
        let len = match body_length(&head.headers) {
            Ok(n) => n,
            Err(code) => {
                let _ = write_error(&mut s, code);
                close_gently(&mut s);
                return;
            }
        };
        let tokens = connection_tokens(&head.headers);
        let keep = if head.minor >= 1 { !tokens.iter().any(|t| t == "close") } else { tokens.iter().any(|t| t == "keep-alive") };
        let continue_pending = len > 0 && head.minor >= 1 && header(&head.headers, "expect").is_some_and(|v| v.trim().eq_ignore_ascii_case("100-continue"));
        let in_buf = buf.len().min(usize::try_from(len).unwrap_or(usize::MAX));
        let pre: Vec<u8> = buf.drain(..in_buf).collect();
        let is_head = head.method == "HEAD";
        let minor = head.minor;
        let body = BodyReader { stream: reader.take(), pre, remaining: len, continue_pending, taken: false, broken: false };
        let busy = begin();
        let (resp, mut body) = handle(Request { method: head.method, target: head.target, headers: head.headers, body });
        reader = body.stream.take();
        let drain = body.can_drain();
        let keep = keep && drain;
        // 相手が close を求めた(1.1)・keep-alive を求めた(1.0)ときは、その旨を返す。こちらの都合で切るときも close と返す
        let conn = if !keep && (minor >= 1 || !drain) {
            Some("close")
        } else if keep && minor == 0 {
            Some("keep-alive")
        } else {
            None
        };
        let written = write_response(&mut s, minor, is_head, &resp, conn);
        drop(resp);
        drop(busy);
        if written.is_err() {
            return;
        }
        if !keep {
            close_gently(&mut s);
            return;
        }
        if body.remaining > 0 {
            body.stream = reader.take();
            if body.consume(|_| {}).is_err() {
                return;
            }
            reader = body.stream.take();
        }
    }
}

/// 見出しの終わり(空行)の次の位置
fn head_end(buf: &[u8], from: usize) -> Option<usize> {
    let start = from.saturating_sub(3);
    let mut i = start;
    while i < buf.len() {
        if buf[i] == b'\n' {
            if buf.get(i + 1) == Some(&b'\n') {
                return Some(i + 2);
            }
            if buf.get(i + 1) == Some(&b'\r') && buf.get(i + 2) == Some(&b'\n') {
                return Some(i + 3);
            }
        }
        i += 1;
    }
    None
}

fn read_head(s: &mut TcpStream, buf: &mut Vec<u8>) -> Result<Head, HeadError> {
    // 要求の前の空行は読み飛ばす(RFC 9112 2.2)
    let mut started: Option<Instant> = None;
    let mut scanned = 0;
    let mut chunk = [0u8; 8192];
    loop {
        while buf.first() == Some(&b'\n') || buf.starts_with(b"\r\n") {
            let n = if buf[0] == b'\n' { 1 } else { 2 };
            buf.drain(..n);
            scanned = 0;
        }
        if let Some(end) = head_end(buf, scanned) {
            if end > HEAD_MAX {
                return Err(HeadError::Status(431));
            }
            let head = parse_head(&buf[..end]).map_err(HeadError::Status)?;
            buf.drain(..end);
            return Ok(head);
        }
        if buf.len() >= HEAD_MAX {
            return Err(HeadError::Status(431));
        }
        scanned = buf.len();
        // 次の要求を待つ間は長く、要求を読み始めたら短く待つ(見出しを少しずつ送られても、スレッドを持たれ続けない)
        let wait = match started {
            None if buf.is_empty() => IDLE_TIMEOUT,
            None => {
                started = Some(Instant::now());
                IO_TIMEOUT
            }
            Some(t) => IO_TIMEOUT.saturating_sub(t.elapsed()),
        };
        if wait.is_zero() || s.set_read_timeout(Some(wait)).is_err() {
            return Err(HeadError::Gone);
        }
        match s.read(&mut chunk) {
            Ok(0) => return Err(HeadError::Gone),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if started.is_none() && buf.iter().any(|b| *b != b'\r' && *b != b'\n') {
                    started = Some(Instant::now());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(HeadError::Gone),
        }
    }
}

/// RFC 9110 の token の文字
fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

fn parse_head(raw: &[u8]) -> Result<Head, u16> {
    let mut lines = raw.split(|b| *b == b'\n').map(|l| l.strip_suffix(b"\r").unwrap_or(l));
    let line = lines.next().ok_or(400u16)?;
    let mut parts = line.split(|b| *b == b' ').filter(|p| !p.is_empty());
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return Err(400) };
    // 対象の ASCII 外のバイトは受ける(hyper と同じ。parse_request_target が %XX にする)
    if !method.iter().all(|b| is_tchar(*b)) || !target.iter().all(|b| *b > 0x20 && *b != 0x7f) {
        return Err(400);
    }
    let minor = match version {
        b"HTTP/1.1" => 1,
        b"HTTP/1.0" => 0,
        _ => return Err(400),
    };
    let mut headers: Headers = Vec::new();
    for l in lines {
        if l.is_empty() {
            break;
        }
        // 折り返した見出し(obs-fold)・名前の後の空白・制御文字は受けない
        let colon = l.iter().position(|b| *b == b':').ok_or(400u16)?;
        let (name, value) = (&l[..colon], &l[colon + 1..]);
        if name.is_empty() || !name.iter().all(|b| is_tchar(*b)) {
            return Err(400);
        }
        let value = value.trim_ascii();
        if value.iter().any(|b| (*b < 0x20 && *b != b'\t') || *b == 0x7f) {
            return Err(400);
        }
        if headers.len() >= HEADERS_MAX {
            return Err(431);
        }
        headers.push((String::from_utf8_lossy(name).to_ascii_lowercase(), String::from_utf8_lossy(value).into_owned()));
    }
    let method = String::from_utf8_lossy(method).into_owned();
    let target = origin_form(&String::from_utf8_lossy(target));
    Ok(Head { method, target, minor, headers })
}

/// 要求行の対象を path と query の形にする(hyper の uri().path_and_query() と同じ)。絶対形式 http://host/… はホストを除き、
/// 権限形式(CONNECT の host:port)は /
fn origin_form(target: &str) -> String {
    if target.starts_with('/') || target == "*" {
        return target.to_string();
    }
    let Some(i) = target.find("://") else { return "/".into() };
    let rest = &target[i + 3..];
    match rest.find(['/', '?']) {
        Some(j) if rest.as_bytes()[j] == b'/' => rest[j..].to_string(),
        Some(j) => format!("/{}", &rest[j..]),
        None => "/".into(),
    }
}

/// 本文の大きさ(Content-Length。無ければ 0)。食い違う・読めない値と Transfer-Encoding は断る
fn body_length(h: &[(String, String)]) -> Result<u64, u16> {
    if h.iter().any(|(k, _)| k == "transfer-encoding") {
        return Err(400);
    }
    let mut len: Option<u64> = None;
    for (_, v) in h.iter().filter(|(k, _)| k == "content-length") {
        for p in v.split(',') {
            let p = p.trim();
            if p.is_empty() || p.len() > 19 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return Err(400);
            }
            let n: u64 = p.parse().map_err(|_| 400u16)?;
            if len.is_some_and(|l| l != n) {
                return Err(400);
            }
            len = Some(n);
        }
    }
    Ok(len.unwrap_or(0))
}

fn connection_tokens(h: &[(String, String)]) -> Vec<String> {
    h.iter().filter(|(k, _)| k == "connection").flat_map(|(_, v)| v.split(',').map(|t| t.trim().to_ascii_lowercase()).collect::<Vec<_>>()).collect()
}

fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Unknown",
    }
}

/// date 見出しの値(IMF-fixdate)
fn http_date() -> String {
    atlas_core::jsdate::http_date(atlas_core::jsdate::now_ms())
}

/// 応答を書く。見出しは hyper と同じ順(渡された順・connection・content-length・date)。HEAD と 204・304 には本文を付けない。
/// content-length は渡されなければ本文の大きさ(HEAD で本文が空なら付けない)
fn write_response(s: &mut TcpStream, minor: u8, is_head: bool, r: &Resp, conn: Option<&str>) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.{minor} {} {}\r\n", r.status, reason(r.status));
    for (k, v) in &r.headers {
        // 改行を含む値は見出しを壊すので出さない(自分で作る値だけなので、ふだんは起きない)
        if v.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) {
            continue;
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(c) = conn {
        head.push_str(&format!("connection: {c}\r\n"));
    }
    let no_body = r.status == 204 || r.status == 304 || (100..200).contains(&r.status);
    let has_len = r.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-length"));
    if !has_len && !no_body && !(is_head && r.body.is_empty()) {
        head.push_str(&format!("content-length: {}\r\n", r.body.len()));
    }
    head.push_str(&format!("date: {}\r\n\r\n", http_date()));
    s.set_write_timeout(Some(IO_TIMEOUT))?;
    let body: &[u8] = if is_head || no_body { &[] } else { &r.body };
    // 小さい応答は 1 回で書く(Nagle を切っているので、分けると見出しと本文が別のパケットになる)
    if body.len() <= 64 * 1024 {
        let mut all = head.into_bytes();
        all.extend_from_slice(body);
        s.write_all(&all)
    } else {
        s.write_all(head.as_bytes())?;
        s.write_all(body)
    }
}

/// 読めない要求に返す(hyper と同じく本文なしで、接続を切る)
fn write_error(s: &mut TcpStream, status: u16) -> std::io::Result<()> {
    s.set_write_timeout(Some(IO_TIMEOUT))?;
    s.write_all(format!("HTTP/1.1 {status} {}\r\nconnection: close\r\ncontent-length: 0\r\ndate: {}\r\n\r\n", reason(status), http_date()).as_bytes())
}

/// 書き終えてから切る。相手がまだ送っているものを少し読み捨ててから閉じる(読み残しがあると RST になり、相手が応答を読む前に捨てることがある)
fn close_gently(s: &mut TcpStream) {
    let _ = s.shutdown(Shutdown::Write);
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut chunk = [0u8; 8192];
    let mut total = 0usize;
    while total < 1024 * 1024 {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || s.set_read_timeout(Some(left)).is_err() {
            break;
        }
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
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

    fn head(raw: &str) -> Result<Head, u16> {
        parse_head(raw.as_bytes())
    }

    #[test]
    fn parse_head_like_hyper() {
        let h = head("POST /api/x?a=1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-A:  v \r\nx-a: w\r\n\r\n").unwrap();
        assert_eq!((h.method.as_str(), h.target.as_str(), h.minor), ("POST", "/api/x?a=1", 1));
        assert_eq!(header(&h.headers, "x-a").as_deref(), Some("v, w"));
        assert_eq!(header(&h.headers, "host").as_deref(), Some("127.0.0.1:1"));
        // 改行だけの区切り・HTTP/1.0・ASCII 外の対象は受ける
        assert_eq!(head("GET / HTTP/1.0\nHost: x\n\n").unwrap().minor, 0);
        assert_eq!(head("GET /\u{3042} HTTP/1.1\r\n\r\n").unwrap().target, "/\u{3042}");
        // 絶対形式はパスと query だけ、権限形式は /
        assert_eq!(head("GET http://127.0.0.1:1/a.txt?x=1 HTTP/1.1\r\n\r\n").unwrap().target, "/a.txt?x=1");
        assert_eq!(head("GET http://127.0.0.1:1?x HTTP/1.1\r\n\r\n").unwrap().target, "/?x");
        assert_eq!(head("CONNECT 127.0.0.1:1 HTTP/1.1\r\n\r\n").unwrap().target, "/");
        // 壊れた要求は 400、見出しが多すぎれば 431
        for bad in [
            "GARBAGE\r\n\r\n",
            "GET / HTTP/2.0\r\n\r\n",
            "GET / HTTP/1.1 x\r\n\r\n",
            "G(T / HTTP/1.1\r\n\r\n",
            "GET /a\x01 HTTP/1.1\r\n\r\n",
            "GET / HTTP/1.1\r\nbroken\r\n\r\n",
            "GET / HTTP/1.1\r\nX-A : 1\r\n\r\n",
            "GET / HTTP/1.1\r\n: 1\r\n\r\n",
            "GET / HTTP/1.1\r\nX-A: a\x01b\r\n\r\n",
            "GET / HTTP/1.1\r\nX-A: a\r\n b\r\n\r\n",
        ] {
            assert_eq!((bad, head(bad).err()), (bad, Some(400)));
        }
        let many = format!("GET / HTTP/1.1\r\n{}\r\n", (0..=HEADERS_MAX).map(|i| format!("X-{i}: 1\r\n")).collect::<String>());
        assert_eq!(head(&many).err(), Some(431));
    }

    #[test]
    fn body_length_rules() {
        let h = |v: &[(&str, &str)]| v.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Headers>();
        assert_eq!(body_length(&h(&[])), Ok(0));
        assert_eq!(body_length(&h(&[("content-length", "12")])), Ok(12));
        assert_eq!(body_length(&h(&[("content-length", "3"), ("content-length", "3")])), Ok(3));
        assert_eq!(body_length(&h(&[("content-length", "3, 3")])), Ok(3));
        for bad in [vec![("content-length", "3"), ("content-length", "4")], vec![("content-length", "abc")], vec![("content-length", "-1")], vec![("content-length", "")], vec![("content-length", "99999999999999999999")], vec![("transfer-encoding", "chunked")]] {
            assert_eq!(body_length(&h(&bad)), Err(400), "{bad:?}");
        }
    }

    #[test]
    fn head_end_finds_blank_line() {
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n\r\nrest", 0), Some(18));
        assert_eq!(head_end(b"GET / HTTP/1.1\n\nrest", 0), Some(16));
        assert_eq!(head_end(b"GET / HTTP/1.1\r\nHost: x\r\n", 0), None);
        // 前に読んだところの少し前から探す(区切りが 2 回の読み込みにまたがっても見つける)
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n\r\n", 15), Some(18));
    }
}
