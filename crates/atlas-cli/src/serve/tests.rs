//! serve.rs のテスト(packages/cli/test/serve.test.ts・jobs.test.ts の serve の部分の振る舞いを決めているところ)。
//! 子プロセスは差し替えて速く回す(本物の起動は e2e の phase14)。

use super::*;
use crate::jobs::{ChildLike, JOB_ENV, JOB_LOCK_FILE};
use serde_json::json;
use std::fs;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Instant;

fn atlas_html() -> String {
    format!(r#"<!doctype html><html><head><meta name="atlas-token" content="{TOKEN_PLACEHOLDER}"></head><body><script type="application/json" id="atlas-data">{{"version":5,"groups":[]}}</script></body></html>"#)
}

pub(crate) struct Res {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Res {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json(&self) -> Value {
        if self.body.is_empty() { Value::Null } else { serde_json::from_slice(&self.body).unwrap_or(Value::Null) }
    }
}

/// 生の要求を送り、接続が閉じるまで読む(Host を変えた要求も送れる)
pub(crate) fn raw(port: u16, method: &str, path: &str, host: &str, headers: &[(&str, &str)], body: &[u8]) -> Res {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    s.set_nodelay(true).unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut buf = Vec::new();
    let r = s.read_to_end(&mut buf);
    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { panic!("応答の見出しがありません({method} {path}: {r:?} {:?})", String::from_utf8_lossy(&buf)) };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))).collect();
    let mut body = buf[end + 4..].to_vec();
    if headers.iter().any(|(k, v)| k == "transfer-encoding" && v == "chunked") {
        let mut out = Vec::new();
        let mut rest = &body[..];
        while let Some(i) = rest.windows(2).position(|w| w == b"\r\n") {
            let n = usize::from_str_radix(String::from_utf8_lossy(&rest[..i]).trim(), 16).unwrap_or(0);
            rest = &rest[i + 2..];
            if n == 0 {
                break;
            }
            out.extend_from_slice(&rest[..n]);
            rest = &rest[n + 2..];
        }
        body = out;
    }
    Res { status, headers, body }
}

/// 接続を使い回す要求(Node の fetch と同じく keep-alive)。この PC の通信フィルタ(AdGuard など)は新しい接続のたびに
/// 200ms ほど待たせるので、時間を測るテストは接続を使い回さないと猶予の測り方が崩れる
struct Conn {
    s: std::net::TcpStream,
    buf: Vec<u8>,
}

impl Conn {
    fn open(port: u16) -> std::io::Result<Conn> {
        let s = std::net::TcpStream::connect(("127.0.0.1", port))?;
        s.set_read_timeout(Some(Duration::from_secs(30)))?;
        s.set_nodelay(true)?;
        Ok(Conn { s, buf: Vec::new() })
    }

    fn fill(&mut self) -> std::io::Result<()> {
        let mut b = [0u8; 16384];
        let n = self.s.read(&mut b)?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "接続が閉じました"));
        }
        self.buf.extend_from_slice(&b[..n]);
        Ok(())
    }

    fn request(&mut self, method: &str, path: &str, host: &str, headers: &[(&str, &str)], body: &[u8]) -> std::io::Result<Res> {
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: {}\r\n", body.len());
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        let mut all = req.into_bytes();
        all.extend_from_slice(body);
        self.s.write_all(&all)?;
        let end = loop {
            if let Some(e) = self.buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break e;
            }
            self.fill()?;
        };
        let head = String::from_utf8_lossy(&self.buf[..end]).into_owned();
        self.buf.drain(..end + 4);
        let mut lines = head.split("\r\n");
        let status: u16 = lines.next().unwrap_or("").split(' ').nth(1).unwrap_or("0").parse().unwrap_or(0);
        let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))).collect();
        let len: usize = if method == "HEAD" || status == 204 || status == 304 { 0 } else { headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0) };
        let body = if headers.iter().any(|(k, v)| k == "transfer-encoding" && v == "chunked") && method != "HEAD" {
            let mut out = Vec::new();
            loop {
                let i = loop {
                    if let Some(i) = self.buf.windows(2).position(|w| w == b"\r\n") {
                        break i;
                    }
                    self.fill()?;
                };
                let n = usize::from_str_radix(String::from_utf8_lossy(&self.buf[..i]).trim(), 16).unwrap_or(0);
                self.buf.drain(..i + 2);
                while self.buf.len() < n + 2 {
                    self.fill()?;
                }
                out.extend_from_slice(&self.buf[..n]);
                self.buf.drain(..n + 2);
                if n == 0 {
                    break out;
                }
            }
        } else {
            while self.buf.len() < len {
                self.fill()?;
            }
            self.buf.drain(..len).collect()
        };
        Ok(Res { status, headers, body })
    }
}

// ---------- 偽の子プロセス ----------

/// 偽の子プロセスの操作口(テストが出力を書き、終わらせる)
pub(crate) struct FakeCtl {
    out: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    err: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    exit: Mutex<Option<mpsc::Sender<Option<i32>>>>,
    pub killed: AtomicBool,
    /// kill しても止まらない(止める操作が間に合わなかった場合)
    pub ignore_kill: AtomicBool,
}

impl FakeCtl {
    pub fn stdout(&self, s: &str) {
        if let Some(tx) = &*lock(&self.out) {
            let _ = tx.send(s.as_bytes().to_vec());
        }
    }
    pub fn stderr(&self, s: &str) {
        if let Some(tx) = &*lock(&self.err) {
            let _ = tx.send(s.as_bytes().to_vec());
        }
    }
    pub fn exit(&self, code: Option<i32>) {
        lock(&self.out).take();
        lock(&self.err).take();
        if let Some(tx) = lock(&self.exit).take() {
            let _ = tx.send(code);
        }
    }
}

struct ChanReader {
    rx: mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
}

impl Read for ChanReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.buf.is_empty() {
            match self.rx.recv() {
                Ok(b) => self.buf = b,
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len());
        out[..n].copy_from_slice(&self.buf[..n]);
        self.buf.drain(..n);
        Ok(n)
    }
}

struct FakeChild {
    ctl: Arc<FakeCtl>,
    out: Option<mpsc::Receiver<Vec<u8>>>,
    err: Option<mpsc::Receiver<Vec<u8>>>,
    exit: mpsc::Receiver<Option<i32>>,
}

impl ChildLike for FakeChild {
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.out.take().map(|rx| Box::new(ChanReader { rx, buf: vec![] }) as Box<dyn Read + Send>)
    }
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.err.take().map(|rx| Box::new(ChanReader { rx, buf: vec![] }) as Box<dyn Read + Send>)
    }
    fn wait(&mut self) -> std::io::Result<Option<i32>> {
        Ok(self.exit.recv().unwrap_or(None))
    }
    fn killer(&self) -> Box<dyn Fn() + Send + Sync> {
        let c = self.ctl.clone();
        Box::new(move || {
            c.killed.store(true, Ordering::SeqCst);
            if !c.ignore_kill.load(Ordering::SeqCst) {
                c.exit(None);
            }
        })
    }
}

type Calls = Arc<Mutex<Vec<(Vec<String>, Vec<(String, String)>)>>>;

pub(crate) fn fake_spawn(calls: Calls, children: Arc<Mutex<Vec<Arc<FakeCtl>>>>) -> SpawnFn {
    Arc::new(move |args: &[String], env: &[(String, String)]| {
        lock(&calls).push((args.to_vec(), env.to_vec()));
        let (otx, orx) = mpsc::channel();
        let (etx, erx) = mpsc::channel();
        let (xtx, xrx) = mpsc::channel();
        let ctl = Arc::new(FakeCtl { out: Mutex::new(Some(otx)), err: Mutex::new(Some(etx)), exit: Mutex::new(Some(xtx)), killed: AtomicBool::new(false), ignore_kill: AtomicBool::new(false) });
        lock(&children).push(ctl.clone());
        Ok(Box::new(FakeChild { ctl, out: Some(orx), err: Some(erx), exit: xrx }) as Box<dyn ChildLike>)
    })
}

// ---------- テストの場 ----------

pub(crate) struct Env {
    _t: tempfile::TempDir,
    pub dir: PathBuf,
    pub out: PathBuf,
    pub notes: PathBuf,
    pub h: Option<ServeHandle>,
    pub logs: Arc<Mutex<Vec<String>>>,
    conn: Mutex<Option<Conn>>,
}

impl Env {
    pub fn new() -> Env {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().to_path_buf();
        let out = dir.join("out");
        let notes = dir.join("atlas-notes");
        fs::create_dir_all(out.join("sessions")).unwrap();
        fs::write(out.join("atlas.html"), atlas_html()).unwrap();
        fs::write(out.join("sessions").join("a.html"), "<p>a</p>").unwrap();
        fs::write(dir.join("secret.txt"), "x").unwrap();
        Env { _t: t, dir, out, notes, h: None, logs: Arc::new(Mutex::new(vec![])), conn: Mutex::new(None) }
    }

    pub fn start(&mut self, f: impl FnOnce(&mut ServeOptions)) {
        if let Some(h) = self.h.take() {
            h.close("テスト");
        }
        let mut o = ServeOptions::new(&self.out, &self.notes);
        o.open = false;
        let logs = self.logs.clone();
        o.log = Arc::new(move |m: &str| lock(&logs).push(m.to_string()));
        // 設定ファイルはテスト用の場所(リポジトリの atlas.config.json を読まない。無ければ設定なし)
        o.config_path = Some(self.dir.join("atlas.config.json"));
        o.code_stamp = Some(Some("test-code".into()));
        f(&mut o);
        *lock(&self.conn) = None;
        self.h = Some(start_serve(o).unwrap());
    }

    pub fn h(&self) -> &ServeHandle {
        self.h.as_ref().unwrap()
    }
    pub fn port(&self) -> u16 {
        self.h().port
    }
    pub fn token(&self) -> String {
        self.h().token.clone()
    }
    pub fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port())
    }

    /// token つきの要求(token: None で付けない)
    pub fn req(&self, method: &str, path: &str, token: Option<&str>, headers: &[(&str, &str)], body: &[u8]) -> Res {
        let mut hs: Vec<(&str, &str)> = vec![("content-type", "application/json")];
        if let Some(t) = token {
            hs.push(("x-atlas-token", t));
        }
        hs.extend_from_slice(headers);
        // 使い回している接続が切れていたら(応答の後にサーバが閉じたなど)、つなぎ直して 1 度だけ送り直す
        let mut c = lock(&self.conn);
        for _ in 0..2 {
            if c.is_none() {
                *c = Some(Conn::open(self.port()).unwrap());
            }
            match c.as_mut().unwrap().request(method, path, &self.host(), &hs, body) {
                Ok(r) => {
                    if r.header("connection") == Some("close") {
                        *c = None;
                    }
                    return r;
                }
                Err(_) => *c = None,
            }
        }
        panic!("応答がありません({method} {path})")
    }

    pub fn json(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let t = self.token();
        let r = self.req(method, path, Some(&t), &[], body.map(|b| b.to_string()).unwrap_or_default().as_bytes());
        (r.status, r.json())
    }

    pub fn get(&self, path: &str) -> (u16, Value) {
        let r = self.req("GET", path, None, &[], b"");
        (r.status, r.json())
    }

    /// 止まるのを待つ(待ちきれなければ None)
    pub fn done(&self, ms: u64) -> Option<String> {
        let t = Instant::now();
        while t.elapsed() < Duration::from_millis(ms) {
            if let Some(r) = self.h().finished() {
                return Some(r);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }

    pub fn logs(&self) -> Vec<String> {
        lock(&self.logs).clone()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if let Some(h) = self.h.take() {
            h.close("テスト終了");
        }
    }
}

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// 条件を満たすまで待つ
pub(crate) fn until(ms: u64, mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_millis(ms), "待ちきれませんでした");
        sleep(20);
    }
}

// ---------- serve.test.ts ----------

#[test]
fn binds_serves_and_injects_token() {
    let mut e = Env::new();
    e.start(|_| {});
    assert!(e.h().url.starts_with("http://127.0.0.1:") && e.h().url.ends_with("/atlas.html"));
    let r = e.req("GET", "/atlas.html", None, &[], b"");
    assert_eq!(r.status, 200);
    assert!(r.text().contains(&format!("content=\"{}\"", e.token())));
    assert!(!r.text().contains(TOKEN_PLACEHOLDER));
    assert_eq!(r.header("x-frame-options"), Some("DENY"));
    assert_eq!(e.req("GET", "/sessions/a.html", None, &[], b"").status, 200);
    let r = e.req("GET", "/", None, &[], b"");
    assert_eq!((r.status, r.header("location")), (302, Some("/atlas.html")));
    for p in ["/sessions/", "/sessions", "/../secret.txt", "/..%2Fsecret.txt", "/%2e%2e/secret.txt", "/nope.html", "/.serve.json", "/..%5Csecret.txt"] {
        assert_eq!((p, e.req("GET", p, None, &[], b"").status), (p, 404));
    }
    // HEAD は本文を返さない(静的ファイルは大きさだけ返す)
    fs::write(e.out.join("a.txt"), "abcdefgh").unwrap();
    let r = e.req("HEAD", "/a.txt", None, &[], b"");
    assert_eq!((r.status, r.header("content-length"), r.body.len()), (200, Some("8"), 0));
    // .serve.json には port と pid があり token は無い
    let st: Value = serde_json::from_str(&fs::read_to_string(e.out.join(SERVE_STATE_FILE)).unwrap()).unwrap();
    assert_eq!(st["port"], json!(e.port()));
    assert_eq!(st["pid"], json!(std::process::id()));
    assert!(!st.to_string().contains(&e.token()));
    assert_eq!(find_running_server(&e.out), Some(RunningServer { port: e.port(), pid: std::process::id(), code: Some("test-code".into()) }));
    // 印の pid のプロセスが無ければ、ポートに尋ねずに動いていないとみなす(強制終了で残った印)
    let mut c = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" }).args(if cfg!(windows) { ["/c", "exit 0"] } else { ["-c", "exit 0"] }).spawn().unwrap();
    let dead = c.id();
    c.wait().unwrap();
    fs::write(e.out.join(SERVE_STATE_FILE), json!({ "port": e.port(), "pid": dead }).to_string()).unwrap();
    assert_eq!(find_running_server(&e.out), None);
    // pid の無い印は、今までどおりポートに尋ねる
    fs::write(e.out.join(SERVE_STATE_FILE), json!({ "port": e.port() }).to_string()).unwrap();
    assert_eq!(find_running_server(&e.out).map(|r| r.port), Some(e.port()));
}

#[test]
fn http_connection_handling() {
    let mut e = Env::new();
    e.start(|o| o.memo_image_limit = 1024);
    fs::write(e.out.join("a.txt"), "abcdefgh").unwrap();
    let host = e.host();
    // 本文を読まずに断った要求の後も、同じ接続で次の要求に応える(本文は読み捨てる)
    let mut c = Conn::open(e.port()).unwrap();
    let r = c.request("POST", "/api/memos/s1/images", &host, &[("content-type", "image/png")], &[7u8; 100]).unwrap();
    assert_eq!((r.status, r.header("connection")), (403, None));
    let r = c.request("GET", "/a.txt", &host, &[], b"").unwrap();
    assert_eq!((r.status, r.text().as_str(), r.header("content-length")), (200, "abcdefgh", Some("8")));
    // 413 も最後まで読んでから返し、接続は続けて使える
    let r = c.request("POST", "/api/memos/s1/images", &host, &[("x-atlas-token", &e.token()), ("content-type", "image/png")], &vec![0u8; 300_000]).unwrap();
    assert_eq!(r.status, 413);
    assert_eq!(c.request("GET", "/a.txt", &host, &[], b"").unwrap().status, 200);
    // Connection: close には close と返して切る
    let r = raw(e.port(), "GET", "/a.txt", &host, &[], b"");
    assert_eq!((r.status, r.header("connection"), r.text().as_str()), (200, Some("close"), "abcdefgh"));
    // 読めない要求は 400 を返して切る(落ちない)
    let mut s = std::net::TcpStream::connect(("127.0.0.1", e.port())).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    s.write_all(b"GARBAGE\r\n\r\n").unwrap();
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    assert!(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 400 Bad Request\r\n"), "{}", String::from_utf8_lossy(&buf));
    // サーバは動き続ける
    assert_eq!(e.req("GET", "/a.txt", None, &[], b"").status, 200);
}

#[test]
fn code_stamp_header() {
    let mut e = Env::new();
    e.start(|_| {});
    let t = e.token();
    assert_eq!(e.req("POST", "/api/heartbeat", Some(&t), &[], b"").header("x-atlas-code"), Some("test-code"));
    assert_eq!(e.req("GET", "/atlas.html", None, &[], b"").header("x-atlas-code"), Some("test-code"));
    assert_eq!(e.req("GET", "/api/nothing", None, &[], b"").header("x-atlas-code"), Some("test-code"));
    e.start(|o| o.code_stamp = Some(None));
    let t = e.token();
    assert_eq!(e.req("POST", "/api/heartbeat", Some(&t), &[], b"").header("x-atlas-code"), None);
    assert_eq!(find_running_server(&e.out).unwrap().code, None);
}

#[test]
fn memo_api() {
    let mut e = Env::new();
    e.start(|_| {});
    let t = e.token();
    let put = |id: &str, text: &str, rev: &str, token: Option<&str>| {
        let r = e.req("PUT", &format!("/api/memos/{id}"), token, &[], json!({ "text": text, "rev": rev }).to_string().as_bytes());
        (r.status, r.json())
    };
    assert_eq!(e.get("/api/memos/s1").1, json!({ "text": "", "rev": "", "html": "", "updatedAt": null }));
    assert_eq!(put("s1", "# 見出し", "", None).0, 403);
    let saved = put("s1", "# 見出し", "", Some(&t));
    assert_eq!(saved.0, 200);
    assert!(saved.1["html"].as_str().unwrap().contains("<h3>見出し</h3>"));
    assert_eq!(fs::read_to_string(e.notes.join("memos").join("s1.md")).unwrap(), "# 見出し");
    let st = e.get("/api/state").1;
    assert_eq!(st["memos"]["s1"]["excerpt"], "見出し");
    assert_eq!(st["memos"]["s1"]["images"], 0);
    fs::write(e.notes.join("memos").join("s1.md"), "手で更新").unwrap();
    let stale = put("s1", "上書き", saved.1["rev"].as_str().unwrap(), Some(&t));
    assert_eq!(stale.0, 409);
    assert_eq!(fs::read_to_string(e.notes.join("memos").join("s1.md")).unwrap(), "手で更新");
    assert_eq!(put("s1", "上書き", stale.1["rev"].as_str().unwrap(), Some(&t)).0, 200);
    let rev = e.get("/api/memos/s1").1["rev"].as_str().unwrap().to_string();
    let del = put("s1", "", &rev, Some(&t));
    assert_eq!(del.1, json!({ "text": "", "rev": "", "html": "", "updatedAt": null }));
    assert!(!e.notes.join("memos").join("s1.md").exists());
    assert_eq!(e.json("PUT", "/api/memos/s1", Some(json!({ "text": 1, "rev": "" }))).0, 400);
    assert_eq!(e.json("DELETE", "/api/memos/s1", None).0, 405);
}

#[test]
fn memo_same_rev_concurrently_only_one_wins() {
    let mut e = Env::new();
    e.start(|_| {});
    let first = e.json("PUT", "/api/memos/s1", Some(json!({ "text": "元", "rev": "" })));
    let rev = first.1["rev"].as_str().unwrap().to_string();
    let port = e.port();
    let host = e.host();
    let t = e.token();
    let hs: Vec<_> = ["A", "B", "C", "D"]
        .into_iter()
        .map(|text| {
            let (rev, host, t) = (rev.clone(), host.clone(), t.clone());
            std::thread::spawn(move || {
                let r = raw(port, "PUT", "/api/memos/s1", &host, &[("x-atlas-token", &t)], json!({ "text": text, "rev": rev }).to_string().as_bytes());
                (r.status, r.json())
            })
        })
        .collect();
    let rs: Vec<(u16, Value)> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    let mut st: Vec<u16> = rs.iter().map(|r| r.0).collect();
    st.sort();
    assert_eq!(st, vec![200, 409, 409, 409]);
    let won = rs.iter().find(|r| r.0 == 200).unwrap();
    assert_eq!(fs::read_to_string(e.notes.join("memos").join("s1.md")).unwrap(), won.1["text"].as_str().unwrap());
    let names: Vec<String> = fs::read_dir(e.notes.join("memos")).unwrap().map(|x| x.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["s1.md"]);
}

#[test]
fn host_must_be_self() {
    let mut e = Env::new();
    e.start(|_| {});
    let p = e.port();
    assert_eq!(raw(p, "GET", "/atlas.html", "evil.example", &[], b"").status, 403);
    assert_eq!(raw(p, "GET", "/api/memos/s1", &format!("evil.example:{p}"), &[], b"").status, 403);
    assert_eq!(raw(p, "GET", "/api/memos/s1", &format!("localhost:{p}"), &[], b"").status, 200);
    assert_eq!(raw(p, "GET", "/atlas.html", &format!("127.0.0.1:{p}"), &[], b"").status, 200);
}

#[test]
fn memo_ids_and_images() {
    let mut e = Env::new();
    e.start(|o| o.memo_image_limit = 64);
    // .. と %2e%2e は URL の正規化で /api/ になる(404)。どちらでも置き場の外には出ない
    for id in ["..", "%2e%2e"] {
        assert_eq!((id, e.get(&format!("/api/memos/{id}")).0), (id, 404));
    }
    for id in ["..%2Fsecret", "a%2Fb", "%E0%A4%A", ".hidden"] {
        assert_eq!((id, e.get(&format!("/api/memos/{id}")).0), (id, 400));
    }
    let png = [0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    let t = e.token();
    let post = |body: &[u8], token: Option<&str>| e.req("POST", "/api/memos/s1/images", token, &[("content-type", "image/png")], body);
    assert_eq!(post(&png, None).status, 403);
    assert_eq!(post(b"<svg/>", Some(&t)).status, 415);
    assert_eq!(post(&[0u8; 65], Some(&t)).status, 413);
    let ok = post(&png, Some(&t));
    assert_eq!(ok.status, 201);
    let j = ok.json();
    assert_eq!(j["markdown"], format!("![画像](s1/{})", j["name"].as_str().unwrap()));
    let saved = e.json("PUT", "/api/memos/s1", Some(json!({ "text": j["markdown"], "rev": "" })));
    assert!(saved.1["html"].as_str().unwrap().contains("src=\"data:image/png;base64,"));
}

#[test]
fn read_only_view_for_uploaded_out() {
    let mut e = Env::new();
    fs::create_dir_all(&e.notes).unwrap();
    // 前の版のタスクタグ(groups.json)と送った人のタグ(uploadTags)が残っていても、読まずに無視する
    fs::write(e.notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "この PC の", "note": "", "ids": ["s1"] }] }).to_string()).unwrap();
    fs::write(e.out.join("sessions.json"), json!({ "version": 12, "source": { "root": "x", "since": null, "layout": "merged" }, "sessions": [{ "id": "s1", "person": "person-a", "uploadTags": ["武器"], "turns": 0 }] }).to_string()).unwrap();
    e.start(|_| {});
    let s = e.get("/api/state");
    assert_eq!(s.0, 200);
    assert_eq!(s.1["readOnly"], true);
    assert!(s.1.get("groups").is_none());
    assert_eq!(e.json("PUT", "/api/memos/s1", Some(json!({ "text": "x", "rev": "" }))).0, 403);
    assert!(e.req("GET", "/api/memo-editor.js", None, &[], b"").text().contains("読むだけ"));
    // この PC の集計に戻したら(layout が無い)、書ける画面に戻る
    sleep(20);
    fs::write(e.out.join("sessions.json"), json!({ "version": 12, "source": { "root": null, "since": null }, "sessions": [{ "id": "s1", "turns": 0 }] }).to_string()).unwrap();
    let t = e.get("/api/state").1;
    assert!(t.get("readOnly").is_none());
    assert!(t.get("groups").is_none());
}

#[test]
fn memo_editor_js() {
    let mut e = Env::new();
    e.start(|_| {});
    let js = e.req("GET", "/api/memo-editor.js", None, &[], b"");
    assert_eq!(js.status, 200);
    assert!(js.header("content-type").unwrap().contains("javascript"));
    assert!(js.text().contains("../api/memos/"));
}

#[test]
fn state_api() {
    let mut e = Env::new();
    e.start(|_| {});
    let s0 = e.get("/api/state");
    assert_eq!(s0.0, 200);
    assert_eq!(s0.1["version"], json!(1));
    assert_eq!(s0.1["notesDir"], json!(e.notes.to_string_lossy()));
    assert_eq!(s0.1["memos"], json!({}));
    assert!(s0.1.get("groups").is_none() && s0.1.get("groupsPath").is_none());
    // タスクタグの API はもう無い
    assert_eq!(e.json("POST", "/api/groups", Some(json!({ "name": "a", "note": "", "ids": ["1"] }))).0, 404);
    assert_eq!(e.json("POST", &format!("/api/groups/{}/upload", encode_uri_component("a")), None).0, 404);
    assert_eq!(e.get("/api/nope").0, 404);
}

#[test]
fn same_origin_only() {
    let mut e = Env::new();
    e.start(|_| {});
    let p = e.port();
    let st = |h: &[(&str, &str)]| e.req("GET", "/api/state", None, h, b"").status;
    assert_eq!(st(&[("sec-fetch-site", "cross-site")]), 403);
    assert_eq!(st(&[("sec-fetch-site", "same-site")]), 403);
    assert_eq!(st(&[("sec-fetch-site", "same-origin")]), 200);
    assert_eq!(st(&[("origin", "http://evil.example")]), 403);
    assert_eq!(st(&[("origin", &format!("http://127.0.0.1:{p}"))]), 200);
    let t = e.token();
    assert_eq!(e.req("POST", "/api/heartbeat", None, &[], b"").status, 403);
    assert_eq!(e.req("POST", "/api/heartbeat", Some(&t), &[], b"").status, 204);
}

#[test]
fn heartbeat_and_first_heartbeat() {
    let mut e = Env::new();
    e.start(|o| {
        o.first_heartbeat_ms = 300;
        o.idle_ms = 400;
    });
    let t0 = Instant::now();
    let t = e.token();
    let beat = || e.req("POST", "/api/heartbeat", Some(&t), &[], b"");
    beat();
    sleep(250);
    beat();
    sleep(250);
    beat();
    // 最初の 300ms は越えているが heartbeat が続いているので生きている
    assert_eq!(e.get("/api/state").0, 200);
    let reason = e.done(5000).unwrap();
    assert!(t0.elapsed() > Duration::from_millis(500 + 400 - 50));
    assert!(reason.contains("heartbeat が途切れた"), "{reason}");
    assert!(!e.out.join(SERVE_STATE_FILE).exists());
    assert_eq!(find_running_server(&e.out), None);
    // 最初の heartbeat が来ないとき
    e.start(|o| {
        o.first_heartbeat_ms = 200;
        o.idle_ms = 400;
    });
    assert!(e.done(5000).unwrap().contains("最初の heartbeat"));
}

#[test]
fn bye_with_grace() {
    let mut e = Env::new();
    e.start(|o| {
        o.idle_ms = 600_000;
        o.bye_grace_ms = 300;
    });
    let t = e.token();
    let post = |p: &str, client: &str| e.req("POST", &format!("/api/{p}"), Some(&t), &[("x-atlas-client", client)], b"").status;
    assert_eq!(e.req("POST", "/api/bye", None, &[], b"").status, 403);
    post("heartbeat", "a");
    post("heartbeat", "b");
    // a を閉じても b が開いているので止まらない
    assert_eq!(post("bye", "a"), 204);
    sleep(500);
    assert_eq!(e.h().finished(), None);
    // b も閉じたが、猶予の間に次のページ(c)の heartbeat が来たので止まらない
    post("bye", "b");
    sleep(100);
    post("heartbeat", "c");
    sleep(500);
    assert_eq!(e.h().finished(), None);
    let t0 = Instant::now();
    post("bye", "c");
    assert_eq!(e.done(5000).as_deref(), Some("画面がすべて閉じられた"));
    assert!(t0.elapsed() > Duration::from_millis(250));
    assert!(e.logs().iter().any(|l| l == "serve: 開いている画面がすべて閉じられました。0 秒のうちに次の画面が開かなければ止まります"), "{:?}", e.logs());
}

#[test]
fn close_does_not_wait_for_idle_connections() {
    let mut e = Env::new();
    e.start(|o| {
        o.idle_ms = 600_000;
        o.bye_grace_ms = 200;
    });
    let quiet = std::net::TcpStream::connect(("127.0.0.1", e.port())).unwrap();
    let mut partial = std::net::TcpStream::connect(("127.0.0.1", e.port())).unwrap();
    partial.write_all(b"GET /atlas.html HTTP/1.1\r\nHost: 127.0.0.1\r\n").unwrap();
    let t = e.token();
    e.req("POST", "/api/heartbeat", Some(&t), &[("x-atlas-client", "a"), ("x-atlas-seq", "1")], b"");
    e.req("POST", "/api/bye", Some(&t), &[("x-atlas-client", "a"), ("x-atlas-seq", "2")], b"");
    let t0 = Instant::now();
    assert_eq!(e.done(5000).as_deref(), Some("画面がすべて閉じられた"));
    assert!(t0.elapsed() < Duration::from_secs(3));
    // 残っていた接続も切られる
    for mut s in [quiet, partial] {
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut b = [0u8; 16];
        assert!(matches!(s.read(&mut b), Ok(0) | Err(_)));
    }
}

#[test]
fn waits_for_inflight_requests_before_stopping() {
    // aborted: 画面が応答を待たずに閉じた(接続は切れたが、サーバの処理は続いている)
    for aborted in [false, true] {
        let mut e = Env::new();
        let (asked_tx, asked_rx) = mpsc::channel::<()>();
        let (answer_tx, answer_rx) = mpsc::channel::<Option<String>>();
        let asked_tx = Mutex::new(asked_tx);
        let answer_rx = Mutex::new(answer_rx);
        e.start(|o| {
            o.idle_ms = 600_000;
            o.bye_grace_ms = 200;
            o.can_pick = Some(true);
            o.pick = Some(Arc::new(move |_t: &str, _i: Option<&str>| {
                let _ = lock(&asked_tx).send(());
                Ok(lock(&answer_rx).recv().unwrap_or(None))
            }));
        });
        let t = e.token();
        e.req("POST", "/api/heartbeat", Some(&t), &[("x-atlas-client", "a"), ("x-atlas-seq", "1")], b"");
        // フォルダを選ぶ画面が出ている間、応答は返らない
        let (port, host, t2) = (e.port(), e.host(), t.clone());
        let mut slow = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        slow.write_all(format!("POST /api/upload-root HTTP/1.1\r\nHost: {host}\r\nx-atlas-token: {t2}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").as_bytes()).unwrap();
        asked_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let slow = if aborted {
            drop(slow);
            sleep(100);
            None
        } else {
            Some(slow)
        };
        e.req("POST", "/api/bye", Some(&t), &[("x-atlas-client", "a"), ("x-atlas-seq", "2")], b"");
        // 猶予(200ms)は過ぎたが、応えている途中なので止まらない
        sleep(600);
        assert_eq!((aborted, e.h().finished()), (aborted, None));
        assert_eq!(e.logs().iter().filter(|l| l.contains("画面がすべて閉じられた。処理が終わるまで止めずに待ちます")).count(), 1);
        let t0 = Instant::now();
        answer_tx.send(None).unwrap();
        if let Some(mut s) = slow {
            let mut buf = Vec::new();
            s.read_to_end(&mut buf).unwrap();
            let text = String::from_utf8_lossy(&buf);
            assert!(text.starts_with("HTTP/1.1 200"), "{text}");
            assert!(text.ends_with(r#"{"root":null}"#), "{text}");
        }
        // 終わったら、猶予を測り直してから止まる
        assert_eq!(e.done(5000).as_deref(), Some("画面がすべて閉じられた"));
        assert!(t0.elapsed() > Duration::from_millis(150));
    }
}

#[test]
fn bye_seq_ignores_late_heartbeats() {
    let mut e = Env::new();
    e.start(|o| {
        o.idle_ms = 600_000;
        o.bye_grace_ms = 300;
    });
    let t = e.token();
    let post = |p: &str, seq: u32| e.req("POST", &format!("/api/{p}"), Some(&t), &[("x-atlas-client", "a"), ("x-atlas-seq", &seq.to_string())], b"");
    post("heartbeat", 1);
    // bfcache に入った(bye 3)。戻ってきた(heartbeat 4)ので数え直され、止まらない
    post("bye", 3);
    post("heartbeat", 4);
    sleep(500);
    assert_eq!(e.h().finished(), None);
    // 閉じた(bye 6)後に、閉じる前の heartbeat(5)が遅れて届いても、開いている画面に数えないので止まる
    post("bye", 6);
    post("heartbeat", 5);
    assert_eq!(e.done(5000).as_deref(), Some("画面がすべて閉じられた"));
}

#[test]
fn bye_without_seq_is_not_remembered() {
    let mut e = Env::new();
    e.start(|o| {
        o.idle_ms = 600_000;
        o.bye_grace_ms = 300;
    });
    let t = e.token();
    let post = |p: &str| e.req("POST", &format!("/api/{p}"), Some(&t), &[("x-atlas-client", "old")], b"");
    post("heartbeat");
    post("bye");
    post("heartbeat");
    sleep(600);
    assert_eq!(e.h().finished(), None);
}

#[test]
fn folders_api() {
    let mut e = Env::new();
    // logs/<人>/<プロジェクト>/<セッション>
    let logs = e.dir.join("logs");
    for p in ["person-a/proj-a/s1", "person-a/proj-b/s2", "person-b/proj-a/s3"] {
        fs::create_dir_all(logs.join(p)).unwrap();
        fs::write(logs.join(p).join("events.jsonl"), "{\"type\":\"session.start\",\"data\":{\"sessionId\":\"x\",\"version\":1},\"id\":\"e1\",\"timestamp\":\"2026-07-02T09:00:00.000Z\",\"parentId\":null}\n").unwrap();
    }
    let launched: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(vec![]));
    let l2 = launched.clone();
    e.start(|o| {
        o.reports.launch = Some(Arc::new(move |args: &[String], _log: &str| {
            lock(&l2).push(args.to_vec());
            Some(std::process::id())
        }));
    });
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let post = |path: &str, body: Value| e.json("POST", &format!("/api/folders/{path}"), Some(body));
    assert_eq!(e.get("/api/folders").0, 403);
    assert_eq!(e.req("POST", "/api/folders/open", None, &[], json!({ "path": s(&logs) }).to_string().as_bytes()).status, 403);
    assert_eq!(e.json("PUT", "/api/folders", Some(json!({}))).0, 405);
    assert_eq!(post("nope", json!({})).0, 404);
    let empty = e.json("GET", "/api/folders", None);
    assert_eq!(empty.0, 200);
    assert_eq!((empty.1["current"].clone(), empty.1["local"].clone(), empty.1["folders"].clone()), (Value::Null, json!({ "status": "current", "url": null }), json!([])));
    assert!(empty.1["canPick"].is_boolean());
    let c = post("check", json!({ "path": s(&logs) }));
    assert_eq!((c.1["path"].clone(), c.1["ok"].clone(), c.1["name"].clone()), (json!(s(&logs)), json!(true), json!("logs")));
    assert!(c.1["summary"].as_str().unwrap().contains("3 件のフォルダをまとめて集計します"));
    assert_eq!(post("check", json!({ "path": s(&logs.join("person-a")) })).1["summary"], "下のフォルダ 2 件をまとめて集計します(proj-a、proj-b)");
    let nope = post("check", json!({ "path": s(&e.dir.join("nope")) }));
    assert_eq!((nope.1["ok"].clone(), nope.1["path"].clone()), (json!(false), json!(s(&e.dir.join("nope")))));
    assert!(nope.1["error"].as_str().unwrap().contains("見つかりません"));
    assert!(post("check", json!({ "path": "logs" })).1["error"].as_str().unwrap().contains("フルパス"));
    assert_eq!(post("check", json!({})).1, json!({ "path": "", "ok": false, "error": post("check", json!({})).1["error"] }));
    // 開く: 別のプロセスに、フォルダと、いつもの出力先・メモの場所・設定ファイルを渡す(ブラウザを開かない指定も引き継ぐ)
    let opened = post("open", json!({ "path": s(&logs.join("person-a")) }));
    assert_eq!((opened.0, opened.1["name"].clone(), opened.1["status"].clone()), (200, json!("person-a"), json!("starting")));
    assert_eq!(
        lock(&launched).clone(),
        vec![vec!["open".to_string(), s(&logs.join("person-a")), "--out".into(), s(&e.out), "--notes-dir".into(), s(&e.notes), "--config".into(), s(&e.dir.join("atlas.config.json")), "--no-open".into()]]
    );
    assert_eq!(post("open", json!({ "path": s(&logs.join("person-a")) })).1["status"], "starting");
    assert_eq!(lock(&launched).len(), 1);
    assert_eq!(post("open", json!({ "path": s(&e.dir.join("nope")) })).0, 400);
    let key = opened.1["key"].as_str().unwrap().to_string();
    let root = PathBuf::from(format!("{}-folders", s(&e.out)));
    assert!(root.join(&key).join("folder.json").exists());
    assert!(!e.out.join("folder.json").exists());
    let list = e.json("GET", "/api/folders", None).1;
    assert_eq!((list["folders"][0]["key"].clone(), list["folders"][0]["status"].clone()), (json!(key), json!("starting")));
    assert_eq!(post("forget", json!({ "key": "../x" })).0, 400);
    assert_eq!(post("forget", json!({ "key": "none-00000000" })).0, 404);
    assert_eq!(post("forget", json!({ "key": key })).1["folders"], json!([]));
    assert!(root.join(&key).join("folder.json").exists());
}

#[test]
fn folders_api_for_opened_folder_server() {
    let mut e = Env::new();
    let logs = e.dir.join("logs");
    fs::create_dir_all(logs.join("proj").join("s1")).unwrap();
    fs::write(logs.join("proj").join("s1").join("events.jsonl"), "{}\n").unwrap();
    let (root, notes, local) = (e.dir.join("reports"), e.notes.clone(), e.dir.join("local-out"));
    let l = logs.to_string_lossy().into_owned();
    e.start(|o| {
        o.home = Some(l.clone());
        o.reports = ReportsOptions { root: Some(root), notes_base: Some(notes), local_out: Some(local), current: Some(l.clone()), launch: Some(Arc::new(|_: &[String], _: &str| None)) };
    });
    let b = e.json("GET", "/api/folders", None).1;
    assert_eq!(b["current"], json!({ "path": logs.to_string_lossy(), "name": "logs", "settings": null }));
    assert_eq!(b["local"], json!({ "status": "idle", "url": null }));
    assert_eq!(b["folders"], json!([]));
    // 開いたときに使った設定のフォルダ(folder.json の settings)を、この画面の設定として返す
    let fp = crate::folders::folder_paths(&s(&e.dir.join("reports")), &s(&e.notes), &l);
    let st = e.dir.join("share").join(crate::settings_dir::SETTINGS_DIR_NAME);
    crate::folders::write_folder_state(&fp.state, &crate::folders::FolderState { version: 1, path: l.clone(), name: "logs".into(), added_at: "t".into(), opened_at: "t".into(), listed: true, run: None, settings: Some(s(&st)) }).unwrap();
    let b = e.json("GET", "/api/folders", None).1;
    assert_eq!(b["current"]["settings"], json!({ "path": s(&st), "name": "AtlasSettings", "from": null }));
}

/// 「調べる」: そのフォルダを開いたら使う設定のフォルダ(上へ探して見つけたもの)を返す
#[test]
fn folders_check_shows_settings_dir() {
    let mut e = Env::new();
    let logs = e.dir.join("SessionLog");
    fs::create_dir_all(logs.join("alice").join("proj").join("s1")).unwrap();
    fs::write(logs.join("alice").join("proj").join("s1").join("events.jsonl"), "{}\n").unwrap();
    e.start(|_| {});
    let check = |p: &Path| e.json("POST", "/api/folders/check", Some(json!({ "path": s(p) }))).1;
    assert_eq!(check(&logs.join("alice"))["settings"], Value::Null);
    let st = e.dir.join(crate::settings_dir::SETTINGS_DIR_NAME);
    fs::create_dir_all(&st).unwrap();
    fs::write(st.join("atlas.config.json"), "{}").unwrap();
    assert_eq!(check(&logs.join("alice"))["settings"], json!({ "path": s(&st), "name": "AtlasSettings", "from": "found" }));
}

#[test]
fn defaults_are_long_enough() {
    assert!(DEFAULT_IDLE_MS >= 10 * 60_000);
    assert!(BYE_GRACE_MS >= 10_000);
    assert!(HEARTBEAT_INTERVAL_MS < BYE_GRACE_MS);
}

// ---------- jobs.test.ts ----------

struct JobEnv {
    e: Env,
    calls: Calls,
    children: Arc<Mutex<Vec<Arc<FakeCtl>>>>,
    fulls: Arc<Mutex<Vec<String>>>,
    full_mode: Arc<Mutex<&'static str>>,
}

impl JobEnv {
    fn new() -> JobEnv {
        let e = Env::new();
        fs::create_dir_all(e.out.join("full").join("assets").join("s1")).unwrap();
        fs::create_dir_all(e.out.join("full").join("assets").join("s2")).unwrap();
        fs::write(
            e.out.join("sessions.json"),
            json!({ "sessions": [
                { "id": "s1", "name": "調べもの <b>", "turns": 2, "firstUserMessage": "x" },
                { "id": "s2", "name": null, "turns": 1, "firstUserMessage": "y" },
                { "id": "s3", "name": "空", "turns": 0, "firstUserMessage": null },
            ] })
            .to_string(),
        )
        .unwrap();
        JobEnv { e, calls: Arc::new(Mutex::new(vec![])), children: Arc::new(Mutex::new(vec![])), fulls: Arc::new(Mutex::new(vec![])), full_mode: Arc::new(Mutex::new("ok")) }
    }

    fn start(&mut self, f: impl FnOnce(&mut ServeOptions)) {
        let spawn = fake_spawn(self.calls.clone(), self.children.clone());
        let fulls = self.fulls.clone();
        let mode = self.full_mode.clone();
        self.e.start(|o| {
            o.job_spawn = Some(spawn);
            o.job_env = vec![("ATLAS_TEST_MARK".into(), "1".into())];
            o.run_full = Some(Arc::new(move |id: &str, ctx: &FullCtx| {
                lock(&fulls).push(id.to_string());
                match *lock(&mode) {
                    "fail" => anyhow::bail!("スナップショットがありません"),
                    "wait" => {
                        while !ctx.canceled.load(Ordering::SeqCst) {
                            sleep(10);
                        }
                        anyhow::bail!("取り消しました")
                    }
                    _ => {
                        (ctx.log)(&format!("全文 {id}"));
                        Ok(())
                    }
                }
            }));
            f(o);
        });
    }

    fn post(&self, body: Value) -> (u16, Value) {
        self.e.json("POST", "/api/jobs", Some(body))
    }

    fn current(&self) -> Value {
        self.e.json("GET", "/api/jobs/current", None).1
    }

    fn wait_not_running(&self) {
        until(3000, || self.current()["state"] != "running");
    }

    fn child(&self, i: usize) -> Arc<FakeCtl> {
        lock(&self.children)[i].clone()
    }

    fn args(&self, i: usize) -> Vec<String> {
        lock(&self.calls)[i].0.clone()
    }
}

impl Drop for JobEnv {
    fn drop(&mut self) {
        for c in lock(&self.children).iter() {
            c.exit(Some(0));
        }
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn jobs_spawn_fixed_args_and_keep_log_lines() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    let (out, notes) = (s(&j.e.out), s(&j.e.notes));
    assert_eq!(j.current(), Value::Null);
    let r = j.post(json!({ "kind": "refresh" }));
    assert_eq!(r.0, 202);
    assert_eq!((r.1["kind"].clone(), r.1["state"].clone(), r.1["exitCode"].clone(), r.1["endedAt"].clone()), (json!("refresh"), json!("running"), Value::Null, Value::Null));
    assert_eq!(j.args(0), vec!["all".to_string(), "--out".into(), out.clone(), "--notes-dir".into(), notes.clone()]);
    let env = lock(&j.calls)[0].1.clone();
    assert!(env.contains(&("ATLAS_TEST_MARK".into(), "1".into())));
    assert!(env.contains(&("ATLAS_CONFIG".into(), s(&j.e.dir.join("atlas.config.json")))));
    // 実行中の印: 子プロセスには JOB_ENV を渡し(自分の印で止まらない)、out/.job.json に serve の pid を置く
    assert!(env.contains(&(JOB_ENV.into(), "1".into())));
    let lockf: Value = serde_json::from_str(&fs::read_to_string(j.e.out.join(JOB_LOCK_FILE)).unwrap()).unwrap();
    assert_eq!((lockf["pid"].clone(), lockf["kind"].clone()), (json!(std::process::id()), json!("refresh")));
    assert_eq!(j.post(json!({ "kind": "bundle" })).0, 409);
    assert_eq!(j.post(json!({ "kind": "full", "id": "s1" })).0, 409);
    assert_eq!(lock(&j.calls).len(), 1);
    j.child(0).stdout("一行目\r\n二行");
    sleep(30);
    j.child(0).stdout("目の続き\n");
    j.child(0).stderr("警告\n");
    sleep(30);
    j.child(0).exit(Some(0));
    j.wait_not_running();
    let c = j.current();
    assert_eq!((c["state"].clone(), c["exitCode"].clone()), (json!("done"), json!(0)));
    let mut log: Vec<String> = c["log"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    log.sort();
    let mut want = vec!["一行目".to_string(), "二行目の続き".into(), "警告".into()];
    want.sort();
    assert_eq!(log, want);
    assert!(!j.e.out.join(JOB_LOCK_FILE).exists());
    assert_eq!(j.post(json!({ "kind": "turn-bundle-zip" })).0, 202);
    assert_eq!(j.args(1), vec!["turns".to_string(), "bundle".into(), "--unjudged".into(), "--zip".into(), "--out".into(), out.clone(), "--notes-dir".into(), notes.clone()]);
    j.child(1).exit(Some(1));
    j.wait_not_running();
    let c = j.current();
    assert_eq!((c["kind"].clone(), c["state"].clone(), c["exitCode"].clone(), c["target"].clone()), (json!("turn-bundle-zip"), json!("failed"), json!(1), json!({})));
    // 200 行だけ残す
    j.post(json!({ "kind": "refresh" }));
    j.child(2).stdout(&(0..250).map(|i| format!("行 {i}\n")).collect::<String>());
    j.child(2).exit(Some(0));
    until(3000, || j.current()["state"] == "done");
    let log = j.current()["log"].as_array().unwrap().clone();
    assert_eq!((log.len(), log[0].clone(), log[199].clone()), (200, json!("行 50"), json!("行 249")));
}

#[test]
fn job_request_validation() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    let bad: Vec<(Value, u16)> = vec![
        (json!({}), 400),
        (json!({ "kind": "nope" }), 400),
        (json!({ "kind": "refresh", "out": "x" }), 400),
        // このツールの中で判定するジョブは無くなった(前の版の画面が送ってきたら、分かる文言で断る)
        (json!({ "kind": "judge", "limit": 3, "backend": "copilot-cli" }), 410),
        (json!({ "kind": "turn-judge", "limit": 3 }), 410),
        (json!({ "kind": "task-link" }), 410),
        (json!({ "kind": "full" }), 400),
        (json!({ "kind": "bundle", "perPart": 2 }), 400),
        (json!({ "kind": "bundle-zip", "zip": false }), 400),
        (json!({ "kind": "turn-bundle-zip", "limit": 1 }), 400),
        (json!({ "kind": "task-bundle", "session": "s1" }), 400),
        (json!({ "kind": "task-m365", "limit": 1 }), 400),
        (json!({ "kind": "export", "id": "s1" }), 400),
        (json!({ "kind": "full", "id": ".." }), 400),
        (json!({ "kind": "full", "id": "a/b" }), 400),
        (json!({ "kind": "full", "id": "s1 & calc" }), 400),
        (json!({ "kind": "full", "id": "nope" }), 404),
    ];
    for (body, status) in bad {
        assert_eq!((body.clone(), j.post(body.clone()).0), (body, status));
    }
    let t = j.e.token();
    assert_eq!(j.e.req("POST", "/api/jobs", Some(&t), &[], b"[1]").status, 400);
    assert!(lock(&j.calls).is_empty());
    assert!(lock(&j.fulls).is_empty());
    use crate::jobs::JobRequest;
    let p = |v: Value| parse_job_request(v.as_object().unwrap(), &|id| id != "nope");
    for (kind, want) in [
        ("turn-bundle-zip", JobRequest::TurnBundleZip),
        ("task-bundle", JobRequest::TaskBundle),
        ("task-bundle-zip", JobRequest::TaskBundleZip),
        ("task-m365", JobRequest::TaskM365),
    ] {
        assert_eq!(p(json!({ "kind": kind })), Ok(want));
    }
    let gone = p(json!({ "kind": "judge", "limit": 1 })).unwrap_err();
    assert!(gone.message.contains("無くなりました") && gone.message.contains("ZIP"), "{}", gone.message);
    // 前の版の画面は、読み込み直すだけでは変わらない(集計し直すと作り直される)
    assert!(gone.message.contains("「集計し直す」か atlas export"), "{}", gone.message);
    let bad: Vec<(Value, u16)> = vec![
        // タスクタグの範囲(group)は、もう受けない
        (json!({ "kind": "bundle", "group": "調査: A/B" }), 400),
        (json!({ "kind": "full", "id": "s1", "session": "s1" }), 400),
    ];
    for (body, status) in bad {
        let got = p(body.clone()).map_err(|e| e.status);
        assert_eq!((body.clone(), got), (body, Err(status)));
    }
}

/// 判定の履歴に入る工数の判定(judgments.json の項目と同じ形)
fn effort_history_item(id: &str) -> Value {
    json!({
        "sessionId": id, "taskCategory": "feature", "taskSummary": "s",
        "humanEffort": { "hours": 2, "low": 1, "high": 4, "confidence": 0.5, "rationale": "r" },
        "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": "r" },
        "instructionsEffect": { "score": 0, "evidence": "e" }, "wikiEffect": { "score": 0, "evidence": "e" }, "skillsAgentsEffect": { "score": 0, "evidence": "e" },
        "judge": { "backend": "external", "ranAt": "2026-07-01T12:00:00.000Z" },
    })
}

/// 添付ファイルを作る前に出す、未判定の数(工数・依頼ごと)
#[test]
fn judge_preview_counts_effort_and_turns() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    fs::write(j.e.out.join("judgments.json"), json!({ "schemaVersion": 1, "items": [{ "sessionId": "s1" }] }).to_string()).unwrap();
    let pv = |q: &str| j.e.json("GET", &format!("/api/jobs/judge-preview{q}"), None);
    let counts = |v: &Value| (v["eligible"].clone(), v["judged"].clone(), v["pending"].clone());
    // 判定の日時もセッションの終わりも無いので、判定し直せるものは 0
    assert_eq!(pv("").1, json!({ "eligible": 2, "judged": 1, "pending": 1, "rejudgeable": 0, "rejudgeFresh": 0 }));
    // 依頼ごと: s1 は 2 依頼、s2 は依頼ごとの記録が無い
    fs::write(
        j.e.out.join("sessions.json"),
        json!({ "sessions": [
            { "id": "s1", "name": "a", "turns": 2, "firstUserMessage": "x", "analysis": { "turnStats": [{}, {}] } },
            { "id": "s2", "name": "b", "turns": 1, "firstUserMessage": "y" },
        ] })
        .to_string(),
    )
    .unwrap();
    let t = pv("?target=turns").1;
    assert_eq!((counts(&t), t["withoutTurns"].clone()), ((json!(2), json!(0), json!(2)), json!(1)));
    // 判定し直せる工数の判定: 判定より前に終わっていたセッション(bundle --rejudge と同じ決まり)。判定の履歴にあるものは「まだ判定し直していない」に数えない
    fs::write(
        j.e.out.join("sessions.json"),
        json!({ "sessions": [
            { "id": "s1", "name": "a", "turns": 1, "firstUserMessage": "x", "updatedAt": "2026-07-01T00:00:00.000Z" },
            { "id": "s2", "name": "b", "turns": 1, "firstUserMessage": "y", "updatedAt": "2026-07-01T00:00:00.000Z" },
            { "id": "s3", "name": "c", "turns": 1, "firstUserMessage": "z", "updatedAt": "2026-07-05T00:00:00.000Z" },
        ] })
        .to_string(),
    )
    .unwrap();
    let judged = |id: &str| json!({ "sessionId": id, "humanEffort": { "hours": 1 }, "judge": { "backend": "external", "ranAt": "2026-07-02T00:00:00.000Z" } });
    fs::write(j.e.out.join("judgments.json"), json!({ "schemaVersion": 1, "items": [judged("s1"), judged("s2"), judged("s3")] }).to_string()).unwrap();
    fs::write(j.e.out.join("judgments-history.json"), json!({ "schemaVersion": 1, "items": [{ "replacedAt": "2026-07-02T00:00:00.000Z", "item": effort_history_item("s2") }] }).to_string()).unwrap();
    let e = pv("").1;
    assert_eq!((e["rejudgeable"].clone(), e["rejudgeFresh"].clone()), (json!(2), json!(1)));
    // 判定のモデルや回数の目安は、もう返さない(このツールは判定しない)
    for k in ["model", "byok", "modelError", "chunk"] {
        assert!(t.get(k).is_none() && pv("").1.get(k).is_none(), "{k}");
    }
    // タスクの設定も記録も無ければ、タスクへの紐づけは 0
    assert_eq!(pv("?target=tasks").1, json!({ "eligible": 0, "judged": 0, "pending": 0 }));
    // 前の版の詳細ページは ?session= で 1 セッションの件数を聞く。全体の件数を返さず、無くなったことを知らせる(そのページは判定の欄を出さない)
    for q in ["?session=s1", "?session=s1&target=turns"] {
        let (st, v) = pv(q);
        assert_eq!(st, 410, "{q}");
        assert!(v["error"].as_str().unwrap().contains("集計し直す"), "{v}");
        assert!(v.get("pending").is_none());
    }
}

#[test]
fn chat_judge_parts_and_import() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    let (out, notes) = (s(&j.e.out), s(&j.e.notes));
    assert_eq!(j.post(json!({ "kind": "bundle" })).0, 202);
    assert_eq!(j.args(0), vec!["bundle".to_string(), "--unjudged".into(), "--out".into(), out.clone(), "--notes-dir".into(), notes.clone()]);
    // 実行中は取り込めない(judgments.json に書くので)
    assert_eq!(j.e.json("POST", "/api/judge/import", Some(json!({ "text": "x" }))).0, 409);
    j.child(0).exit(Some(0));
    j.wait_not_running();
    assert_eq!(j.post(json!({ "kind": "export" })).0, 202);
    assert_eq!(j.args(1), vec!["export".to_string(), "--out".into(), out.clone(), "--notes-dir".into(), notes.clone()]);
    j.child(1).exit(Some(0));
    j.wait_not_running();
    assert_eq!(j.post(json!({ "kind": "bundle-zip" })).0, 202);
    assert_eq!(j.args(2), vec!["bundle".to_string(), "--unjudged".into(), "--zip".into(), "--out".into(), out, "--notes-dir".into(), notes]);
    j.child(2).exit(Some(0));
    j.wait_not_running();
    assert_eq!(j.e.json("GET", "/api/judge/parts", None).1, json!({ "exists": false, "canAutomate": cfg!(windows) }));
    let b = j.e.out.join("bundle");
    fs::create_dir_all(b.join("parts")).unwrap();
    fs::write(b.join("parts").join("part-01.md"), "# 指示\nパケット s1 s2").unwrap();
    fs::write(b.join("secret.md"), "出さない").unwrap();
    fs::write(
        b.join("manifest.json"),
        json!({ "version": 1, "generatedAt": "2026-11-05T00:00:00.000Z", "scope": { "unjudged": "yes" }, "count": 2, "sessions": [], "parts": [{ "path": "parts/part-01.md", "sessions": ["s1", "s2"], "bytes": 30 }, { "path": "parts/part-02.md", "sessions": ["s3"], "bytes": 9 }] }).to_string(),
    )
    .unwrap();
    // 消えたファイル(part-02)は一覧に出さない
    assert_eq!(
        j.e.json("GET", "/api/judge/parts", None).1,
        json!({ "exists": true, "generatedAt": "2026-11-05T00:00:00.000Z", "unjudgedOnly": true, "count": 2, "parts": [{ "path": "bundle/parts/part-01.md", "name": "part-01.md", "sessions": 2, "judged": 0, "bytes": 30 }], "judged": 0, "canAutomate": cfg!(windows) })
    );
    assert_eq!(j.e.json("GET", "/api/judge/parts/part-01.md", None).1, json!({ "name": "part-01.md", "text": "# 指示\nパケット s1 s2" }));
    // ZIP: 束の一覧より後に書いたものだけを返す(出力先からの相対パスだけ。フルパスは返さない)。前の束の ZIP は返さない
    let zip = j.e.out.join("bundle.zip");
    fs::write(&zip, b"PK-fake").unwrap();
    let z = j.e.json("GET", "/api/judge/parts", None).1["zip"].clone();
    assert_eq!((z["path"].clone(), z["bytes"].clone(), z.get("file")), (json!("bundle.zip"), json!(7), None));
    assert!(z["modifiedAt"].as_str().is_some_and(|t| t.ends_with('Z')));
    // ZIP は out/ の下のファイルとして取れる(保存のリンク)
    let got = j.e.req("GET", "/bundle.zip", None, &[], b"");
    assert_eq!((got.status, got.header("content-type"), got.body.as_slice()), (200, Some("application/zip"), b"PK-fake".as_slice()));
    let old = atlas_core::jsfs::mtime_ms(&fs::metadata(b.join("manifest.json")).unwrap()) as i64 - 60_000;
    atlas_core::jsfs::utimes(&zip, old, old).unwrap();
    assert_eq!(j.e.json("GET", "/api/judge/parts", None).1.get("zip"), None);
    fs::remove_file(&zip).unwrap();
    for bad in ["part-02.md", "..%2Fsecret.md", "secret.md"] {
        assert_eq!((bad, j.e.json("GET", &format!("/api/judge/parts/{bad}"), None).0), (bad, 404));
    }
    let import = |text: &str| j.e.json("POST", "/api/judge/import", Some(json!({ "text": text })));
    assert_eq!(import("").0, 400);
    assert!(import("JSON の無い返答").1["error"].as_str().unwrap().contains("JSON を取り出せません"));
    let bad = import("```json\n{\"items\":[{\"sessionId\":\"s1\"}]}\n```");
    assert_eq!(bad.0, 400);
    assert!(!bad.1["problems"].as_array().unwrap().is_empty());
    assert!(!j.e.out.join("judgments.json").exists());
    let item = json!({
        "sessionId": "s1", "taskCategory": "feature", "taskSummary": "要約",
        "humanEffort": { "hours": 2, "low": 1, "high": 4, "confidence": 0.5, "rationale": "根拠" },
        "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": "成果" },
        "instructionsEffect": { "score": 1, "evidence": "e" }, "wikiEffect": { "score": 0, "evidence": "参照なし" }, "skillsAgentsEffect": { "score": 0, "evidence": "参照なし" },
    });
    let mut zz = item.clone();
    zz["sessionId"] = json!("zz");
    let reply = format!("判定しました。\n```json\n{}\n```", json!({ "schemaVersion": 1, "judge": { "backend": "external", "model": "m365", "ranAt": null }, "items": [item, zz] }));
    assert_eq!(j.e.req("POST", "/api/judge/import", None, &[], json!({ "text": reply }).to_string().as_bytes()).status, 403);
    let ok = import(&reply);
    assert_eq!(ok.0, 200);
    assert_eq!((ok.1["imported"].clone(), ok.1["overwritten"].clone(), ok.1["unknownIds"].clone(), ok.1["total"].clone()), (json!(2), json!(0), json!(["zz"]), json!(2)));
    assert_eq!((ok.1["parts"]["parts"][0]["name"].clone(), ok.1["parts"]["parts"][0]["judged"].clone()), (json!("part-01.md"), json!(1)));
    // 取り込んだ後の一覧も、読んだときと同じ形(M365 Copilot を自動で操作できるかが入る)
    assert_eq!(ok.1["parts"]["canAutomate"], json!(cfg!(windows)));
    // 今の判定のファイルが壊れていれば、書き換えずに 409(直してもう一度)
    let saved = fs::read(j.e.out.join("judgments.json")).unwrap();
    fs::write(j.e.out.join("judgments.json"), "{ 壊れた").unwrap();
    let broken = import(&reply);
    assert_eq!(broken.0, 409, "{}", broken.1);
    let msg = broken.1["error"].as_str().unwrap();
    assert!(msg.starts_with("判定のファイルが壊れています。") && msg.contains("judgments.json を確かめてください"), "{msg}");
    assert_eq!(fs::read_to_string(j.e.out.join("judgments.json")).unwrap(), "{ 壊れた");
    fs::write(j.e.out.join("judgments.json"), saved).unwrap();
    let pv = j.e.json("GET", "/api/jobs/judge-preview", None).1;
    assert_eq!((pv["eligible"].clone(), pv["judged"].clone(), pv["pending"].clone()), (json!(2), json!(1), json!(1)));
    assert_eq!(j.e.get("/api/judge/parts").0, 403);
}

/// serve --judgments X: 画面の取り込み先(X)と、ジョブ(子プロセス)の読み先をそろえる。どのジョブにも --judgments X を渡す
#[test]
fn jobs_get_the_same_judgments_file_as_the_screen() {
    let mut j = JobEnv::new();
    let mine = j.e.dir.join("mine").join("judgments.json");
    let m = mine.clone();
    j.start(move |o| o.judgments = Some(m));
    let (out, notes) = (s(&j.e.out), s(&j.e.notes));
    assert_eq!(j.post(json!({ "kind": "bundle" })).0, 202);
    assert_eq!(j.args(0), vec!["bundle".to_string(), "--unjudged".into(), "--out".into(), out.clone(), "--notes-dir".into(), notes.clone(), "--judgments".into(), s(&mine)]);
    j.child(0).exit(Some(0));
    j.wait_not_running();
    assert_eq!(j.post(json!({ "kind": "export" })).0, 202);
    assert_eq!(j.args(1), vec!["export".to_string(), "--out".into(), out, "--notes-dir".into(), notes, "--judgments".into(), s(&mine)]);
    j.child(1).exit(Some(0));
    j.wait_not_running();
    // 画面に貼った返答も同じファイルに書く(出力先の judgments.json には書かない)
    let item = json!({
        "sessionId": "s1", "taskCategory": "feature", "taskSummary": "要約",
        "humanEffort": { "hours": 2, "low": 1, "high": 4, "confidence": 0.5, "rationale": "根拠" },
        "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": "成果" },
        "instructionsEffect": { "score": 1, "evidence": "e" }, "wikiEffect": { "score": 0, "evidence": "参照なし" }, "skillsAgentsEffect": { "score": 0, "evidence": "参照なし" },
    });
    let r = j.e.json("POST", "/api/judge/import", Some(json!({ "text": json!([item]).to_string() })));
    assert_eq!(r.0, 200, "{}", r.1);
    assert!(mine.is_file() && !j.e.out.join("judgments.json").exists());
}

/// 返答の取り込みで、ほかの書き手がロックを持ったまま待ちきれなかったときは 409(少し待ってもう一度。タスクの紐づけの書き込みと同じ)
#[test]
fn import_lock_busy_is_409() {
    let busy: anyhow::Error = anyhow::Error::from(atlas_report::tasks::LockBusy("judgments.json を別の処理が書き換えています".into())).context("取り込めません");
    let e = import_error(&busy);
    assert_eq!(e.status, 409);
    assert!(e.message.contains("ほかの人(か別の処理)が書き込み中です。少し待ってから、もう一度取り込んでください"), "{}", e.message);
    assert_eq!(import_error(&anyhow::Error::from(atlas_report::tasks::BrokenFile("壊れています".into()))).status, 409);
    assert_eq!(import_error(&anyhow::anyhow!("JSON を取り出せません")).status, 400);
}

#[test]
fn jobs_need_token_origin_and_host() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    let body = json!({ "kind": "refresh" }).to_string();
    let t = j.e.token();
    assert_eq!(j.e.req("POST", "/api/jobs", None, &[], body.as_bytes()).status, 403);
    assert_eq!(j.e.req("POST", "/api/jobs", Some("wrong"), &[], body.as_bytes()).status, 403);
    assert_eq!(j.e.req("POST", "/api/jobs", Some(&t), &[("origin", "http://evil.example")], body.as_bytes()).status, 403);
    assert_eq!(j.e.req("POST", "/api/jobs", Some(&t), &[("sec-fetch-site", "cross-site")], body.as_bytes()).status, 403);
    assert_eq!(j.e.get("/api/jobs/current").0, 403);
    assert_eq!(j.e.req("POST", "/api/jobs/current/cancel", None, &[], b"").status, 403);
    assert_eq!(j.e.get("/api/jobs/judge-preview").0, 403);
    assert_eq!(j.e.get("/api/view/s1?kind=transcript").0, 403);
    assert_eq!(j.e.req("GET", "/view/s1?kind=transcript", None, &[("sec-fetch-site", "cross-site")], b"").status, 403);
    let p = j.e.port();
    assert_eq!(raw(p, "POST", "/api/jobs", &format!("evil.example:{p}"), &[("x-atlas-token", &t)], body.as_bytes()).status, 403);
    assert_eq!(raw(p, "GET", "/view/s1", &format!("evil.example:{p}"), &[], b"").status, 403);
    assert!(lock(&j.calls).is_empty());
}

#[test]
fn cancel_jobs() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    assert_eq!(j.e.json("POST", "/api/jobs/current/cancel", None).0, 409);
    j.post(json!({ "kind": "refresh" }));
    assert_eq!(j.e.json("POST", "/api/jobs/current/cancel", None).0, 200);
    assert!(j.child(0).killed.load(Ordering::SeqCst));
    j.wait_not_running();
    assert_eq!(j.current()["state"], "canceled");
    // 止める操作が間に合わず、最後まで終わった(終了コード 0)ものは完了のまま(結果は書かれている)
    j.post(json!({ "kind": "bundle" }));
    j.child(1).ignore_kill.store(true, Ordering::SeqCst);
    assert_eq!(j.e.json("POST", "/api/jobs/current/cancel", None).0, 200);
    j.child(1).exit(Some(0));
    j.wait_not_running();
    let c = j.current();
    assert_eq!((c["kind"].clone(), c["state"].clone(), c["exitCode"].clone()), (json!("bundle"), json!("done"), json!(0)));
    *lock(&j.full_mode) = "wait";
    assert_eq!(j.post(json!({ "kind": "full", "id": "s2" })).0, 202);
    // 全文はサーバ内(子プロセスを起動しない)
    assert_eq!(lock(&j.calls).len(), 2);
    until(3000, || lock(&j.fulls).len() == 1);
    j.e.json("POST", "/api/jobs/current/cancel", None);
    j.wait_not_running();
    let c = j.current();
    assert_eq!((c["kind"].clone(), c["state"].clone(), c["target"].clone()), (json!("full"), json!("canceled"), json!({ "id": "s2" })));
}

#[test]
fn full_job_done_or_failed() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    assert_eq!(j.post(json!({ "kind": "full", "id": "s1" })).0, 202);
    j.wait_not_running();
    let c = j.current();
    assert_eq!((c["kind"].clone(), c["state"].clone(), c["log"].clone()), (json!("full"), json!("done"), json!(["全文 s1"])));
    *lock(&j.full_mode) = "fail";
    j.post(json!({ "kind": "full", "id": "s1" }));
    j.wait_not_running();
    let c = j.current();
    assert_eq!((c["state"].clone(), c["log"].clone()), (json!("failed"), json!(["失敗しました: スナップショットがありません"])));
}

#[test]
fn running_job_keeps_server_alive() {
    let mut j = JobEnv::new();
    j.start(|o| {
        o.idle_ms = 150;
        o.first_heartbeat_ms = 600_000;
    });
    j.post(json!({ "kind": "refresh" }));
    let t = j.e.token();
    j.e.req("POST", "/api/heartbeat", Some(&t), &[], b"");
    sleep(500);
    // 猶予(150ms)の 3 倍待っても動いている
    assert_eq!(j.current()["state"], "running");
    let t0 = Instant::now();
    j.child(0).exit(Some(0));
    let reason = j.e.done(5000).unwrap();
    assert!(reason.contains("heartbeat が途切れた"));
    assert!(t0.elapsed() > Duration::from_millis(100));
}

#[test]
fn bye_during_job_then_short_grace() {
    let mut j = JobEnv::new();
    j.start(|o| {
        o.idle_ms = 600_000;
        o.bye_grace_ms = 150;
        o.first_heartbeat_ms = 600_000;
    });
    let t = j.e.token();
    j.e.req("POST", "/api/heartbeat", Some(&t), &[("x-atlas-client", "p1"), ("x-atlas-seq", "1")], b"");
    j.post(json!({ "kind": "refresh" }));
    j.e.req("POST", "/api/bye", Some(&t), &[("x-atlas-client", "p1"), ("x-atlas-seq", "2")], b"");
    sleep(500);
    assert_eq!(j.current()["state"], "running");
    let t0 = Instant::now();
    j.child(0).exit(Some(0));
    assert_eq!(j.e.done(5000).as_deref(), Some("画面がすべて閉じられた"));
    assert!(t0.elapsed() < Duration::from_secs(5));
}

#[test]
fn refreshing_404_message() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    assert_eq!(j.e.req("GET", "/sessions/nope.html", None, &[], b"").text(), "ありません");
    j.post(json!({ "kind": "refresh" }));
    let r = j.e.req("GET", "/sessions/nope.html", None, &[], b"");
    assert_eq!(r.status, 404);
    assert!(r.text().contains("集計し直している最中"));
    assert!(j.e.json("GET", "/api/view/s1?kind=transcript", None).1["error"].as_str().unwrap().contains("集計し直している最中"));
}

const MD: &str = "# セッション記録: テスト\n\n## 経過\n\n<script>window.__pwned = 1</script>\n\n<img src=x onerror=\"window.__pwned=2\">\n\n[危ない](javascript:alert(1)) と [外](https://example.com/a) と [相対](../../secret.txt)\n\n![外部の画像](https://example.com/x.png)\n\n```\n<b>コードの中</b>\n```\n\n## 変更したファイル";

fn view_env() -> JobEnv {
    let j = JobEnv::new();
    let out = &j.e.out;
    fs::write(out.join("sessions").join("s1.md"), MD).unwrap();
    let a = out.join("full").join("assets");
    fs::write(a.join("s1").join("a.png"), [0x89u8, 0x50, 0x4e, 0x47]).unwrap();
    fs::write(a.join("s1").join("data.bin"), "x").unwrap();
    fs::write(a.join("s1").join("icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>bad()</script></svg>").unwrap();
    fs::write(a.join("s1").join("page.html"), "<script>bad()</script>").unwrap();
    fs::write(a.join("s2").join("b.png"), "x").unwrap();
    fs::write(out.join("secret.png"), "x").unwrap();
    fs::write(
        out.join("full").join("s1.md"),
        ["# 全文記録", "", "![画像](assets/s1/a.png)", "", "[書き出したファイル](assets/s1/data.bin)", "", "[svg の画像](assets/s1/icon.svg) と ![svg](assets/s1/icon.svg) と [html](assets/s1/page.html)", "", "![別のセッション](assets/s2/b.png)", "", "![外へ](../secret.png)", "", "![無い](assets/s1/none.png)", "", "<script>bad()</script>", "", "- **session.start** <small>id e1</small> と <small onclick=\"bad()\">属性つき</small> と <SMALL>大文字</SMALL>", "", "<details><summary>要約</summary>", "", "> 要約の本文", "", "</details>"].join("\n"),
    )
    .unwrap();
    j
}

#[test]
fn view_shell_has_token_not_body() {
    let mut j = view_env();
    j.start(|_| {});
    let shell = j.e.req("GET", "/view/s1?kind=transcript", None, &[], b"");
    assert_eq!(shell.status, 200);
    let html = shell.text();
    assert!(html.contains(&format!("content=\"{}\"", j.e.token())));
    assert!(!html.contains("__pwned"));
    assert!(html.contains("../sessions/s1.html"));
    assert!(html.contains("../sessions/s1.md"));
    assert_eq!(j.e.req("GET", "/view/s1?kind=nope", None, &[], b"").status, 400);
    assert_eq!(j.e.req("GET", "/view/..%2Fx", None, &[], b"").status, 400);
    assert_eq!(j.e.req("GET", "/api/session-tools.js", None, &[], b"").status, 200);
}

#[test]
fn view_transcript_is_safe() {
    let mut j = view_env();
    j.start(|_| {});
    let (st, b) = j.e.json("GET", "/api/view/s1?kind=transcript", None);
    assert_eq!(st, 200);
    assert_eq!((b["title"].clone(), b["docTitle"].clone(), b["tooLarge"].clone(), b["size"].clone()), (json!("調べもの <b>"), json!("セッション記録: テスト"), json!(false), json!(MD.len())));
    let html = b["html"].as_str().unwrap();
    assert!(!html.to_lowercase().contains("<script"));
    assert!(html.contains("&lt;script&gt;window.__pwned = 1&lt;/script&gt;"));
    assert!(!html.to_lowercase().contains("<img"));
    assert!(!html.contains("href=\"javascript"));
    assert!(html.contains("href=\"https:&#47;&#47;example.com/a\""));
    assert!(html.contains("外部の画像(読み込みません)"));
    assert!(html.contains("<h2 id=\"h-1\">経過</h2>"));
    assert_eq!(b["headings"], json!([{ "id": "h-1", "text": "経過" }, { "id": "h-2", "text": "変更したファイル" }]));
}

#[test]
fn view_full_only_own_assets() {
    let mut j = view_env();
    j.start(|_| {});
    let html = j.e.json("GET", "/api/view/s1?kind=full", None).1["html"].as_str().unwrap().to_string();
    assert!(html.contains("<img src=\"../full/assets/s1/a.png\" alt=\"画像\">"));
    assert!(html.contains("<a href=\"../full/assets/s1/data.bin\">書き出したファイル</a>"));
    assert_eq!(html.matches("<img").count(), 1);
    let svg = j.e.req("GET", "/full/assets/s1/icon.svg", None, &[], b"");
    assert_eq!(svg.status, 200);
    assert!(svg.header("content-security-policy").unwrap().starts_with("sandbox"));
    assert_eq!(svg.header("x-content-type-options"), Some("nosniff"));
    let shell = j.e.req("GET", "/view/s1?kind=full", None, &[], b"");
    assert_eq!(shell.header("x-frame-options"), Some("DENY"));
    assert!(shell.header("content-security-policy").unwrap().contains("frame-ancestors 'none'"));
    // atlas の画面以外の .html(snapshot の写しなど)には token を入れず、sandbox で返す
    let files = j.e.out.join("snapshot").join("session-state").join("s1").join("files");
    fs::create_dir_all(&files).unwrap();
    fs::write(files.join("page.html"), format!("<meta name=\"atlas-token\" content=\"{TOKEN_PLACEHOLDER}\"><script>bad()</script>")).unwrap();
    let copied = j.e.req("GET", "/snapshot/session-state/s1/files/page.html", None, &[], b"");
    assert!(copied.header("content-security-policy").unwrap().starts_with("sandbox"));
    assert!(!copied.text().contains(&j.e.token()));
    assert!(html.contains("画像を表示できません: ../secret.png"));
    assert!(html.contains("<small>id e1</small>"));
    assert_eq!(j.e.json("GET", "/api/view/s2?kind=full", None).0, 404);
    assert_eq!(j.e.json("GET", "/api/view/nope?kind=full", None).0, 404);
    assert_eq!(j.e.json("GET", "/api/view/s1?kind=raw", None).0, 400);
}

#[test]
fn view_too_large() {
    let mut j = view_env();
    j.start(|o| o.view_limit = 64);
    let (st, b) = j.e.json("GET", "/api/view/s1?kind=transcript", None);
    assert_eq!(st, 200);
    assert_eq!((b["tooLarge"].clone(), b["limit"].clone(), b["size"].clone(), b["mdHref"].clone()), (json!(true), json!(64), json!(MD.len()), json!("../sessions/s1.md")));
    assert!(b.get("html").is_none());
}

// ---------- 管理ツールのタスク ----------

/// タスクの状態(tasks.json)と設定(atlas.config.json の tasks)と sessions.json を置いた場
fn tasks_env() -> Env {
    let e = Env::new();
    fs::create_dir_all(&e.notes).unwrap();
    fs::write(e.dir.join("export.xml"), "<Tasks/>").unwrap();
    fs::write(e.dir.join("atlas.config.json"), json!({ "tasks": { "file": "export.xml" } }).to_string()).unwrap();
    let task = |name: &str, done: bool| json!({ "name": name, "status": if done { "Done" } else { "Open" }, "done": done, "firstSeenAt": "2026-11-20T00:00:00.000Z", "doneAt": if done { json!("2026-11-24T03:00:00.000Z") } else { Value::Null }, "lastSeenAt": "2026-11-24T03:00:00.000Z", "missing": false });
    fs::write(e.notes.join("tasks.json"), json!({ "version": 1, "tasks": { "ABC-12": task("一覧の不具合", true), "XY-9": task("帳票の出力", false) } }).to_string()).unwrap();
    fs::write(
        e.out.join("sessions.json"),
        json!({ "sessions": [
            { "id": "s1", "name": "ABC-12 を直す", "turns": 1, "firstUserMessage": "直して", "createdAt": "2026-11-23T01:00:00.000Z", "activeMs": 3_600_000, "analysis": { "requests": ["直して"] } },
            { "id": "s2", "name": "雑談", "turns": 1, "firstUserMessage": "こんにちは", "createdAt": "2026-11-23T02:00:00.000Z", "activeMs": 600_000 },
        ] })
        .to_string(),
    )
    .unwrap();
    e
}

#[test]
fn tasks_api_and_manual_links() {
    let mut e = tasks_env();
    e.start(|_| {});
    let (st, v) = e.get("/api/tasks");
    assert_eq!(st, 200);
    assert_eq!(v["readOnly"], false);
    assert_eq!(v["tasks"]["configured"], true);
    assert_eq!(v["tasks"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(v["tasks"]["links"], json!({}));
    // LLM に頼む数(依頼の記録があって紐づけの無いセッション)
    assert_eq!(v["unresolved"], 2);
    let put = |id: &str, body: Value, token: bool| {
        let t = e.token();
        let r = e.req("PUT", &format!("/api/tasks/links/{id}"), token.then_some(t.as_str()), &[], body.to_string().as_bytes());
        (r.status, r.json())
    };
    // token が無ければ書かない
    assert_eq!(put("s2", json!({ "taskId": "XY-9" }), false).0, 403);
    // 前の形(taskId が 1 つ)でも送れる
    let (st, v) = put("s2", json!({ "taskId": "XY-9" }), true);
    assert_eq!(st, 200, "{v}");
    assert_eq!(v["tasks"]["links"]["s2"], json!({ "taskIds": ["XY-9"], "countedTaskIds": ["XY-9"], "source": "manual", "reason": "" }));
    assert_eq!(v["unresolved"], 1);
    let saved = js::parse_json(&fs::read_to_string(e.notes.join("task-links.json")).unwrap()).unwrap();
    assert_eq!(saved["links"]["s2"]["source"], "manual");
    // 工数はその場で数え直す(s2 は 10 分の実働)
    let xy = v["tasks"]["items"].as_array().unwrap().iter().find(|t| t["id"] == "XY-9").unwrap().clone();
    assert_eq!((xy["sessions"].clone(), xy["aiActiveMs"].clone(), xy["excluded"].clone()), (json!(1), json!(600_000), json!("notDone")));
    // 推定人手工数はレポートと同じゆるい読み方で読む(必須の項目が欠けた判定でも、時間があれば数える)
    fs::write(e.out.join("judgments.json"), json!({ "schemaVersion": 1, "items": [{ "sessionId": "s2", "humanEffort": { "hours": 3 } }] }).to_string()).unwrap();
    let xy = e.get("/api/tasks").1["tasks"]["items"].as_array().unwrap().iter().find(|t| t["id"] == "XY-9").unwrap().clone();
    assert_eq!((xy["humanHours"].clone(), xy["judgedSessions"].clone()), (json!(3), json!(1)));
    // いくつかのタスク(送った順。重なりは除く)。実働と推定人手工数はタスクの数で等分する
    let (st, v) = put("s2", json!({ "taskIds": ["XY-9", "ABC-12", "XY-9"] }), true);
    assert_eq!(st, 200, "{v}");
    assert_eq!(v["tasks"]["links"]["s2"]["taskIds"], json!(["XY-9", "ABC-12"]));
    let item = |v: &Value, id: &str| v["tasks"]["items"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap().clone();
    assert_eq!((item(&v, "XY-9")["aiActiveMs"].clone(), item(&v, "XY-9")["humanHours"].clone(), item(&v, "XY-9")["sharedSessions"].clone()), (json!(300_000), json!(1.5), json!(1)));
    assert_eq!((item(&v, "ABC-12")["aiActiveMs"].clone(), item(&v, "ABC-12")["sessions"].clone()), (json!(300_000), json!(1)));
    assert_eq!(v["tasks"]["summary"]["sharedSessions"], 1);
    let saved = js::parse_json(&fs::read_to_string(e.notes.join("task-links.json")).unwrap()).unwrap();
    assert_eq!(saved["version"], 2);
    assert_eq!(saved["links"]["s2"]["taskIds"], json!(["XY-9", "ABC-12"]));
    assert!(saved["links"]["s2"].get("taskId").is_none());
    // 上限を超えた並び・知らないタスク・文字列でない ID は断る
    // 重なりを除いてから上限を確かめる(同じ ID を上限より多く送っても 1 つ)
    let same: Vec<String> = (0..=atlas_report::tasks::links::MAX_TASKS_PER_SESSION).map(|_| "XY-9".to_string()).collect();
    let (st, v) = put("s2", json!({ "taskIds": same }), true);
    assert_eq!(st, 200, "{v}");
    assert_eq!(v["tasks"]["links"]["s2"]["taskIds"], json!(["XY-9"]));
    let many: Vec<String> = (0..=atlas_report::tasks::links::MAX_TASKS_PER_SESSION).map(|i| format!("T-{i}")).collect();
    let (st, v) = put("s2", json!({ "taskIds": many }), true);
    assert_eq!(st, 400);
    assert!(v["error"].as_str().unwrap().contains("個まで"), "{v}");
    // 一覧に無いタスクは、無いものを全部書いて断る
    let (st, v) = put("s2", json!({ "taskIds": ["XY-9", "NOPE", "GONE"] }), true);
    assert_eq!(st, 400);
    assert!(v["error"].as_str().unwrap().contains("「NOPE」「GONE」"), "{v}");
    put("s2", json!({ "taskIds": ["XY-9", "ABC-12"] }), true);
    assert_eq!(put("s2", json!({ "taskIds": ["XY-9", 1] }), true).0, 400);
    assert_eq!(put("s2", json!({ "taskIds": [""] }), true).0, 400);
    assert_eq!(put("s2", json!({ "taskIds": "XY-9" }), true).0, 400);
    assert_eq!(put("s2", json!({ "taskIds": ["XY-9"], "taskId": "XY-9" }), true).0, 400);
    assert_eq!(put("s2", json!({ "taskIds": ["XY-9"], "auto": true }), true).0, 400);
    // 断ったものは書いていない
    assert_eq!(e.get("/api/tasks").1["tasks"]["links"]["s2"]["taskIds"], json!(["XY-9", "ABC-12"]));
    // 「どのタスクでもない」(空の並び。前の形の null も同じ)
    let (_, v) = put("s2", json!({ "taskIds": [] }), true);
    assert_eq!(v["tasks"]["links"]["s2"]["taskIds"], json!([]));
    assert_eq!(v["tasks"]["links"]["s2"]["source"], "manual");
    let (_, v) = put("s2", json!({ "taskId": null }), true);
    assert_eq!(v["tasks"]["links"]["s2"]["taskIds"], json!([]));
    // 自動に戻すと、機械の紐づけをすぐ決め直す(s1 は題名に ID がある)
    let (_, v) = put("s1", json!({ "taskId": "XY-9" }), true);
    assert_eq!(v["tasks"]["links"]["s1"]["source"], "manual");
    let (st, v) = put("s1", json!({ "auto": true }), true);
    assert_eq!(st, 200);
    assert_eq!(v["tasks"]["links"]["s1"], json!({ "taskIds": ["ABC-12"], "countedTaskIds": ["ABC-12"], "source": "machine", "reason": "ID が題名にある" }));
    let (_, v) = put("s2", json!({ "auto": true }), true);
    assert!(v["tasks"]["links"].get("s2").is_none());
    // LLM の紐づけも自動に戻せる(機械の紐づけを決め直す)
    let links_path = e.notes.join("task-links.json");
    let mut saved = js::parse_json(&fs::read_to_string(&links_path).unwrap()).unwrap();
    saved["links"]["s1"] = json!({ "taskId": "XY-9", "source": "llm", "reason": "LLM", "confidence": 0.7, "at": "t" });
    fs::write(&links_path, saved.to_string()).unwrap();
    let (st, v) = put("s1", json!({ "auto": true }), true);
    assert_eq!(st, 200);
    assert_eq!(v["tasks"]["links"]["s1"]["source"], "machine");
    // 形の違うもの
    assert_eq!(put("s1", json!({ "taskId": "NOPE" }), true).0, 400);
    assert_eq!(put("s1", json!({ "taskId": 1 }), true).0, 400);
    assert_eq!(put("s1", json!({ "taskId": "XY-9", "auto": true }), true).0, 400);
    assert_eq!(put("s1", json!({ "task": "XY-9" }), true).0, 400);
    assert_eq!(put("zz", json!({ "taskId": "XY-9" }), true).0, 404);
    assert_eq!(put("a%2Fb", json!({ "taskId": "XY-9" }), true).0, 400);
    assert_eq!(e.json("GET", "/api/tasks/links/s1", None).0, 405);
    assert_eq!(e.json("POST", "/api/tasks", None).0, 405);
    // 壊れた task-links.json は書き換えない
    fs::write(e.notes.join("task-links.json"), "{ 壊れた").unwrap();
    assert_eq!(put("s1", json!({ "taskId": "XY-9" }), true).0, 409);
    assert_eq!(fs::read_to_string(e.notes.join("task-links.json")).unwrap(), "{ 壊れた");
    assert!(!e.get("/api/tasks").1["tasks"]["warnings"].as_array().unwrap().is_empty());
    // ロックそのものを作れない(書けない)ときは 500 と理由
    fs::remove_file(e.notes.join("task-links.json")).unwrap();
    let lock = e.notes.join("task-links.json.lock");
    let _ = fs::remove_file(&lock);
    fs::create_dir_all(&lock).unwrap();
    let (st, v) = put("s1", json!({ "taskId": "XY-9" }), true);
    assert_eq!(st, 500, "{v}");
    assert!(v["error"].as_str().unwrap().contains("ロックのファイル"), "{v}");
}

/// 画面に出す「LLM に頼むセッション」の数は、tasks bundle が束に入れるものと同じ決め方(開いただけ・文の無い・候補の無いセッションは数えない)
#[test]
fn unresolved_count_matches_the_llm_job() {
    let mut e = tasks_env();
    let task = |done_at: Option<&str>| json!({ "name": "前に終わった仕事", "status": "Done", "done": done_at.is_some(), "firstSeenAt": "t", "doneAt": done_at, "lastSeenAt": "t" });
    fs::write(e.notes.join("tasks.json"), json!({ "version": 1, "tasks": { "OLD-1": task(Some("2026-11-10T00:00:00.000Z")) } }).to_string()).unwrap();
    fs::write(
        e.out.join("sessions.json"),
        json!({ "sessions": [
            { "id": "a", "name": "前の作業", "turns": 1, "createdAt": "2026-11-05T00:00:00.000Z" },
            { "id": "b", "name": "開いただけ", "turns": 0, "empty": true, "createdAt": "2026-11-05T00:00:00.000Z" },
            { "id": "c", "name": "", "turns": 1, "createdAt": "2026-11-05T00:00:00.000Z" },
            { "id": "d", "name": "後の作業", "turns": 1, "firstUserMessage": "直して", "createdAt": "2026-11-20T00:00:00.000Z" },
        ] })
        .to_string(),
    )
    .unwrap();
    e.start(|_| {});
    assert_eq!(e.get("/api/tasks").1["unresolved"], 1);
    assert_eq!(e.json("GET", "/api/jobs/judge-preview?target=tasks", None).1["pending"], 1);
}

#[test]
fn tasks_api_without_config_and_read_only() {
    let mut e = Env::new();
    fs::write(e.out.join("sessions.json"), json!({ "sessions": [{ "id": "s1", "turns": 0 }] }).to_string()).unwrap();
    e.start(|_| {});
    // 設定もタスクの記録も無ければ節は無い
    assert_eq!(e.get("/api/tasks").1, json!({ "readOnly": false, "tasks": null, "unresolved": 0 }));
    // 送り先から集計した出力先: 送った人がセッションごとに添えた記録から作り、紐づけは書き換えない
    let meta = e.out.join("snapshot").join("session-state").join("s1");
    fs::create_dir_all(&meta).unwrap();
    // 今の版の記録(tasks の並び)。前の版の task(1 つ)は sender.rs のテストで読む
    let t = |id: &str, name: &str| json!({ "id": id, "name": name, "status": "Done", "done": true, "doneAt": "2026-11-20T03:00:00Z", "source": "llm", "reason": "r" });
    fs::write(meta.join("atlas-session.json"), json!({ "version": 1, "id": "s1", "tasks": [t("T-1", "送った人のタスク"), t("T-2", "もう一つ")] }).to_string()).unwrap();
    sleep(20);
    fs::write(e.out.join("sessions.json"), json!({ "source": { "root": "x", "since": null, "layout": "merged" }, "sessions": [{ "id": "s1", "turns": 0, "createdAt": "2026-11-19T01:00:00Z" }] }).to_string()).unwrap();
    let v = e.get("/api/tasks").1;
    assert_eq!(v["readOnly"], true);
    assert_eq!(v["tasks"]["origin"], "sender");
    assert_eq!(v["tasks"]["items"][0]["name"], "送った人のタスク");
    assert_eq!(v["tasks"]["links"]["s1"]["source"], "llm");
    assert_eq!(v["tasks"]["links"]["s1"]["taskIds"], json!(["T-1", "T-2"]));
    assert_eq!(v["tasks"]["items"][1]["sharedSessions"], 1);
    assert_eq!(e.json("PUT", "/api/tasks/links/s1", Some(json!({ "taskId": null }))).0, 403);
    assert_eq!(e.json("PUT", "/api/tasks/links/s1", Some(json!({ "taskIds": [] }))).0, 403);
    // タスクの紐づけの添付ファイルと取り込みも断る(紐づけは送った人のもの)
    for (method, path) in [("GET", "/api/judge/parts?target=tasks"), ("GET", "/api/judge/parts/part-01.md?target=tasks"), ("POST", "/api/judge/import?target=tasks")] {
        assert_eq!(e.json(method, path, (method == "POST").then(|| json!({ "text": "{}" }))).0, 403, "{path}");
    }
    assert_eq!(e.json("GET", "/api/jobs/judge-preview?target=tasks", None).1["pending"], 0);
    assert!(!e.notes.join("task-links.json").exists());
}

/// 設定のフォルダの設定に tasks がある、開いたフォルダのサーバ: メモは読むだけのまま、タスクの紐づけは設定のフォルダに書ける
#[test]
fn central_tasks_in_opened_folder_server() {
    let mut e = tasks_env();
    // tasks_env の設定とタスクの状態を、設定のフォルダに移す(メモの置き場には置かない)
    let st = e.dir.join(crate::settings_dir::SETTINGS_DIR_NAME);
    fs::create_dir_all(&st).unwrap();
    fs::rename(e.dir.join("atlas.config.json"), st.join("atlas.config.json")).unwrap();
    fs::rename(e.dir.join("export.xml"), st.join("export.xml")).unwrap();
    fs::rename(e.notes.join("tasks.json"), st.join("tasks.json")).unwrap();
    let logs = e.dir.join("logs");
    fs::create_dir_all(&logs).unwrap();
    let (l, stc) = (s(&logs), st.clone());
    e.start(|o| {
        o.config_path = Some(stc.join("atlas.config.json"));
        o.settings_dir = Some(stc.clone());
        o.reports.current = Some(l.clone());
    });
    // メモは読むだけ
    assert_eq!(e.get("/api/state").1["readOnly"], true);
    assert_eq!(e.json("PUT", "/api/memos/s1", Some(json!({ "text": "x", "rev": "" }))).0, 403);
    // タスクは設定のフォルダから読み、紐づけを変えられる
    let v = e.get("/api/tasks").1;
    assert_eq!((v["readOnly"].clone(), v["tasks"]["origin"].clone()), (json!(false), json!("local")));
    assert_eq!(e.json("PUT", "/api/tasks/links/s2", Some(json!({ "taskIds": ["XY-9"] }))).0, 200);
    assert!(st.join("task-links.json").exists());
    assert!(!e.notes.join("task-links.json").exists());
    assert_eq!(e.json("GET", "/api/judge/parts?target=tasks", None).0, 200);
    // 画面の設定は共有の設定(画面は書き換えの注意を出す)。書き換えたら、共有の設定を書き換えたと 1 行残す
    assert_eq!(e.json("GET", "/api/settings", None).1["sharedSettings"], json!(s(&st)));
    assert_eq!(e.json("PUT", "/api/settings/phases", Some(json!({ "phases": ["設計", "実装"] }))).0, 200);
    let cfg: Value = serde_json::from_str(&fs::read_to_string(st.join("atlas.config.json")).unwrap()).unwrap();
    assert_eq!(cfg["phases"], json!(["設計", "実装"]));
    let shared_logs: Vec<String> = e.logs().into_iter().filter(|l| l.contains("共有の設定(")).collect();
    assert_eq!(shared_logs.len(), 1, "{:?}", e.logs());
    assert!(shared_logs[0].contains("普段の工程名を 設計 / 実装 にしました") && shared_logs[0].contains("ほかの集計する人の結果も変わります"), "{shared_logs:?}");
    // 設定から tasks を外すと、送った人の記録を読むだけに戻る
    fs::write(st.join("atlas.config.json"), "{}").unwrap();
    assert_eq!(e.get("/api/tasks").1["readOnly"], true);
    assert_eq!(e.json("PUT", "/api/tasks/links/s2", Some(json!({ "taskIds": [] }))).0, 403);
}

#[test]
fn task_bundle_jobs() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    let (out, notes) = (s(&j.e.out), s(&j.e.notes));
    let tail = |v: &[&str]| v.iter().map(|x| x.to_string()).chain(["--out".to_string(), out.clone(), "--notes-dir".into(), notes.clone()]).collect::<Vec<_>>();
    let r = j.post(json!({ "kind": "task-bundle" }));
    assert_eq!((r.0, r.1["kind"].clone(), r.1["target"].clone()), (202, json!("task-bundle"), json!({})));
    assert_eq!(j.args(0), tail(&["tasks", "bundle"]));
    // ほかの処理が動いている間は始めない
    assert_eq!(j.post(json!({ "kind": "task-bundle-zip" })).0, 409);
    j.child(0).exit(Some(0));
    j.wait_not_running();
    assert_eq!(j.post(json!({ "kind": "task-bundle-zip" })).0, 202);
    assert_eq!(j.args(1), tail(&["tasks", "bundle", "--zip"]));
    j.child(1).exit(Some(0));
    j.wait_not_running();
    assert_eq!(j.post(json!({ "kind": "task-m365" })).0, 202);
    assert_eq!(j.args(2), tail(&["tasks", "m365"]));
    j.child(2).exit(Some(0));
    j.wait_not_running();
    assert!(j.e.logs().iter().any(|l| l.starts_with("[タスクの紐づけの ZIP を作る] 開始")), "{:?}", j.e.logs());
    // 読むだけの画面では始めない(紐づけは送った人のもの)
    sleep(20);
    fs::write(j.e.out.join("sessions.json"), json!({ "source": { "root": "x", "since": null, "layout": "flat" }, "sessions": [{ "id": "s1", "turns": 1 }] }).to_string()).unwrap();
    for kind in ["task-bundle", "task-bundle-zip", "task-m365"] {
        assert_eq!(j.post(json!({ "kind": kind })).0, 403, "{kind}");
    }
}

/// タスクへの紐づけの添付ファイル(?target=tasks): 一覧・件数・返答の取り込み(候補と照らし、手動の紐づけは変えない)
#[test]
fn task_link_parts_and_import() {
    let mut e = tasks_env();
    e.start(|_| {});
    let pv = e.json("GET", "/api/jobs/judge-preview?target=tasks", None).1;
    assert_eq!(pv, json!({ "eligible": 2, "judged": 0, "pending": 2 }));
    assert_eq!(e.json("GET", "/api/judge/parts?target=tasks", None).1, json!({ "exists": false, "canAutomate": cfg!(windows) }));
    let q = |id: &str| atlas_judge::task_link::LinkQuery { session_id: id.into(), title: "t".into(), prompts: vec![], candidates: vec![("ABC-12".into(), "一覧の不具合".into()), ("XY-9".into(), "帳票の出力".into())], candidates_total: 2 };
    let dir = e.out.join(crate::paths::TASK_BUNDLE_DIR);
    atlas_judge::task_link::build_task_bundle(&[q("s1"), q("s2")], &atlas_judge::task_link::TaskBundleOptions { bundle_dir: dir.clone(), per_part: Some(1), boundary: None, scope: IndexMap::new(), now: Some("2026-11-23T00:00:00.000Z".into()) }).unwrap();
    let parts = e.json("GET", "/api/judge/parts?target=tasks", None).1;
    assert_eq!((parts["exists"].clone(), parts["count"].clone(), parts["judged"].clone()), (json!(true), json!(2), json!(0)));
    assert_eq!(parts["parts"][0], json!({ "path": "task-bundle/parts/part-01.md", "name": "part-01.md", "sessions": 1, "judged": 0, "bytes": parts["parts"][0]["bytes"].clone() }));
    assert!(e.json("GET", "/api/judge/parts/part-02.md?target=tasks", None).1["text"].as_str().unwrap().contains("セッション ID: s2"));
    // 取り込む前に、画面で s2 を手動で紐づけた
    let t = e.token();
    assert_eq!(e.req("PUT", "/api/tasks/links/s2", Some(&t), &[], json!({ "taskIds": ["XY-9"] }).to_string().as_bytes()).status, 200);
    let import = |text: String| e.json("POST", "/api/judge/import?target=tasks", Some(json!({ "text": text })));
    // 候補に無い ID だけの答えは形の誤り(何も書かない。直す点を返す)
    let bad = import(json!({ "links": [{ "sessionId": "s1", "taskIds": ["NOPE"], "confidence": 0.5 }] }).to_string());
    assert_eq!(bad.0, 400);
    assert!(bad.1["error"].as_str().unwrap().contains("紐づけの形式に合いません"), "{}", bad.1);
    assert!(bad.1["problems"][0].as_str().unwrap().contains("NOPE"));
    let ok = import(format!("```json\n{}\n```", json!({ "links": [{ "sessionId": "s1", "taskIds": ["XY-9", "NOPE"], "confidence": 0.6, "reason": "帳票" }, { "sessionId": "s2", "taskIds": [], "confidence": 0.9 }] })));
    assert_eq!(ok.0, 200, "{}", ok.1);
    assert_eq!((ok.1["imported"].clone(), ok.1["kept"].clone(), ok.1["parts"]["judged"].clone()), (json!(1), json!(1), json!(2)));
    // 除いた ID と、書かなかったセッションの知らせを画面に返す
    let notices: Vec<String> = ok.1["notices"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect();
    assert!(notices.iter().any(|n| n.starts_with("手動で紐づけてあるので書かなかったセッション 1 件: s2")), "{notices:?}");
    assert!(notices.iter().any(|n| n.contains("候補に無いタスクの ID を除きました: NOPE")), "{notices:?}");
    let links = e.get("/api/tasks").1["tasks"]["links"].clone();
    assert_eq!((links["s1"]["source"].clone(), links["s1"]["taskIds"].clone()), (json!("llm"), json!(["XY-9"])));
    assert_eq!((links["s2"]["source"].clone(), links["s2"]["taskIds"].clone()), (json!("manual"), json!(["XY-9"])));
    assert_eq!(e.json("GET", "/api/jobs/judge-preview?target=tasks", None).1, json!({ "eligible": 1, "judged": 1, "pending": 0 }));
    assert!(e.logs().iter().any(|l| l.starts_with("tasks import(画面): 1 セッションの紐づけを取り込みました")), "{:?}", e.logs());
}
