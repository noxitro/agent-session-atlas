//! serve.rs のテスト(packages/cli/test/serve.test.ts・jobs.test.ts・group-export.test.ts の serve の部分の振る舞いを決めているところ)。
//! 子プロセスは差し替えて速く回す(本物の起動は e2e の phase14)。

use super::*;
use crate::jobs::{ChildLike, JOB_ENV, JOB_LOCK_FILE};
use serde_json::json;
use std::fs;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Instant;

fn atlas_html(anonymized: bool) -> String {
    format!(r#"<!doctype html><html><head><meta name="atlas-token" content="{TOKEN_PLACEHOLDER}"></head><body><script type="application/json" id="atlas-data">{{"version":5,"anonymized":{anonymized},"groups":[]}}</script></body></html>"#)
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
    rt: tokio::runtime::Runtime,
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
        fs::write(out.join("atlas.html"), atlas_html(false)).unwrap();
        fs::write(out.join("sessions").join("a.html"), "<p>a</p>").unwrap();
        fs::write(dir.join("secret.txt"), "x").unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        Env { _t: t, dir, out, notes, rt, h: None, logs: Arc::new(Mutex::new(vec![])), conn: Mutex::new(None) }
    }

    pub fn start(&mut self, f: impl FnOnce(&mut ServeOptions)) {
        if let Some(h) = self.h.take() {
            h.close("テスト");
        }
        let mut o = ServeOptions::new(&self.out, &self.notes, self.notes.join("groups.json"));
        o.open = false;
        let logs = self.logs.clone();
        o.log = Arc::new(move |m: &str| lock(&logs).push(m.to_string()));
        // 設定ファイルはテスト用の場所(リポジトリの atlas.config.json を読まない。無ければ設定なし)
        o.config_path = Some(self.dir.join("atlas.config.json"));
        o.code_stamp = Some(Some("test-code".into()));
        f(&mut o);
        *lock(&self.conn) = None;
        self.h = Some(self.rt.block_on(start_serve(o)).unwrap());
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
    fs::write(e.notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "この PC の", "note": "", "ids": ["s1"] }] }).to_string()).unwrap();
    fs::write(e.out.join("sessions.json"), json!({ "version": 12, "source": { "root": "x", "since": null, "layout": "merged" }, "sessions": [{ "id": "s1", "person": "person-a", "uploadTags": ["武器"], "turns": 0 }] }).to_string()).unwrap();
    e.start(|_| {});
    let s = e.get("/api/state");
    assert_eq!(s.0, 200);
    assert_eq!(s.1["readOnly"], true);
    assert_eq!(s.1["groups"], json!([{ "name": "person-a / 武器", "note": "", "ids": ["s1"] }]));
    assert_eq!(e.json("POST", "/api/groups", Some(json!({ "name": "x", "note": "", "ids": ["s1"] }))).0, 403);
    assert_eq!(e.json("PUT", "/api/memos/s1", Some(json!({ "text": "x", "rev": "" }))).0, 403);
    assert!(e.req("GET", "/api/memo-editor.js", None, &[], b"").text().contains("読むだけ"));
    // この PC の集計に戻したら(layout が無い)、書ける画面に戻る
    sleep(20);
    fs::write(e.out.join("sessions.json"), json!({ "version": 12, "source": { "root": null, "since": null }, "sessions": [{ "id": "s1", "turns": 0 }] }).to_string()).unwrap();
    let t = e.get("/api/state").1;
    assert!(t.get("readOnly").is_none());
    assert_eq!(t["groups"][0]["name"], "この PC の");
}

#[test]
fn anonymized_blocks_editing() {
    let mut e = Env::new();
    e.start(|_| {});
    let js = e.req("GET", "/api/memo-editor.js", None, &[], b"");
    assert_eq!(js.status, 200);
    assert!(js.header("content-type").unwrap().contains("javascript"));
    assert!(js.text().contains("../api/memos/"));
    fs::write(e.out.join("atlas.html"), atlas_html(true)).unwrap();
    e.start(|_| {});
    assert_eq!(e.req("GET", "/api/memo-editor.js", None, &[], b"").status, 403);
    assert_eq!(e.get("/api/memos/s1").0, 403);
    assert_eq!(e.json("PUT", "/api/memos/s1", Some(json!({ "text": "x", "rev": "" }))).0, 403);
}

#[test]
fn groups_api() {
    let mut e = Env::new();
    e.start(|_| {});
    let s0 = e.get("/api/state");
    assert_eq!(s0.0, 200);
    assert_eq!((s0.1["version"].clone(), s0.1["groups"].clone(), s0.1["exists"].clone(), s0.1["warnings"].clone()), (json!(1), json!([]), json!(false), json!([])));
    assert_eq!(s0.1["notesDir"], json!(e.notes.to_string_lossy()));
    let body = json!({ "name": "a", "note": "", "ids": ["1"] }).to_string();
    assert_eq!(e.req("POST", "/api/groups", None, &[], body.as_bytes()).status, 403);
    assert_eq!(e.req("POST", "/api/groups", Some("wrong"), &[], body.as_bytes()).status, 403);
    let c = e.json("POST", "/api/groups", Some(json!({ "name": " a ", "note": "n", "ids": ["1", "2", "1"] })));
    assert_eq!(c.0, 201);
    assert_eq!(c.1["group"], json!({ "name": "a", "note": "n", "ids": ["1", "2"] }));
    let saved: Value = serde_json::from_str(&fs::read_to_string(e.notes.join("groups.json")).unwrap()).unwrap();
    assert_eq!(saved, json!({ "version": 1, "groups": [{ "name": "a", "note": "n", "ids": ["1", "2"] }] }));
    assert_eq!(e.json("POST", "/api/groups", Some(json!({ "name": "a", "ids": [] }))).0, 409);
    assert_eq!(e.json("POST", "/api/groups", Some(json!({ "name": "", "ids": [] }))).0, 400);
    assert_eq!(e.json("POST", "/api/groups", Some(json!({ "name": "b", "ids": "x" }))).0, 400);
    let t = e.token();
    assert_eq!(e.req("POST", "/api/groups", Some(&t), &[], b"{oops").status, 400);
    assert_eq!(e.json("POST", "/api/groups", Some(json!({ "name": "b", "ids": ["3"] }))).0, 201);
    assert_eq!(e.json("PUT", "/api/groups/a", Some(json!({ "name": "b" }))).0, 409);
    let u = e.json("PUT", "/api/groups/a", Some(json!({ "name": "A", "note": "nn" })));
    assert_eq!(u.0, 200);
    assert_eq!(u.1["group"], json!({ "name": "A", "note": "nn", "ids": ["1", "2"] }));
    assert_eq!(e.json("PUT", "/api/groups/A", Some(json!({ "ids": ["1", "2", "9", "9"] }))).1["group"]["ids"], json!(["1", "2", "9"]));
    assert_eq!(e.json("PUT", "/api/groups/A", Some(json!({ "ids": [] }))).1["group"], json!({ "name": "A", "note": "nn", "ids": [] }));
    // 差分(add / remove)はサーバが読み直した最新の ids に適用する
    fs::write(e.notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "A", "note": "nn", "ids": ["1", "2", "x"] }, { "name": "b", "note": "", "ids": ["3"] }] }).to_string()).unwrap();
    let d1 = e.json("PUT", "/api/groups/A", Some(json!({ "add": ["y", "2", "y"] })));
    assert_eq!((d1.1["added"].clone(), d1.1["dup"].clone(), d1.1["removed"].clone(), d1.1["group"]["ids"].clone()), (json!(1), json!(1), json!(0), json!(["1", "2", "x", "y"])));
    fs::write(e.notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "A", "note": "nn", "ids": ["1", "2", "x", "y", "z"] }, { "name": "b", "note": "", "ids": ["3"] }] }).to_string()).unwrap();
    let d2 = e.json("PUT", "/api/groups/A", Some(json!({ "remove": ["y", "nope"] })));
    assert_eq!((d2.1["added"].clone(), d2.1["removed"].clone(), d2.1["group"]["ids"].clone()), (json!(0), json!(1), json!(["1", "2", "x", "z"])));
    assert_eq!(e.json("PUT", "/api/groups/A", Some(json!({ "add": ["q"], "ids": ["1"] }))).0, 400);
    assert_eq!(e.json("PUT", "/api/groups/A", Some(json!({ "add": "q" }))).0, 400);
    assert_eq!(e.json("PUT", "/api/groups/A", Some(json!({ "ids": ["1", "2"] }))).0, 200);
    assert_eq!(e.json("PUT", "/api/groups/zzz", Some(json!({ "note": "" }))).0, 404);
    assert_eq!(e.json("DELETE", "/api/groups/zzz", None).0, 404);
    let d = e.json("DELETE", "/api/groups/b", None);
    assert_eq!(d.0, 200);
    assert_eq!(d.1["groups"], json!([{ "name": "A", "note": "nn", "ids": ["1", "2"] }]));
    // 壊れたファイルは読みでは警告、書きでは 409 で上書きしない
    fs::write(e.notes.join("groups.json"), "{ broken").unwrap();
    assert_eq!(e.get("/api/state").1["warnings"].as_array().unwrap().len(), 1);
    let broken = e.json("POST", "/api/groups", Some(json!({ "name": "c", "ids": [] })));
    assert_eq!(broken.0, 409);
    assert!(broken.1["error"].as_str().unwrap().contains("書き換えません"));
    assert_eq!(fs::read_to_string(e.notes.join("groups.json")).unwrap(), "{ broken");
    assert_eq!(e.get("/api/nope").0, 404);
    assert_eq!(e.json("PATCH", "/api/groups", None).0, 405);
}

#[test]
fn concurrent_group_changes_all_apply() {
    let mut e = Env::new();
    e.start(|_| {});
    assert_eq!(e.json("POST", "/api/groups", Some(json!({ "name": "g", "ids": [] }))).0, 201);
    let (port, host, t) = (e.port(), e.host(), e.token());
    let mut hs = Vec::new();
    for i in 0..12 {
        let (host, t) = (host.clone(), t.clone());
        hs.push(std::thread::spawn(move || raw(port, "PUT", "/api/groups/g", &host, &[("x-atlas-token", &t)], json!({ "add": [format!("s{i}")] }).to_string().as_bytes()).status));
    }
    for n in ["h1", "h2", "h3"] {
        let (host, t) = (host.clone(), t.clone());
        hs.push(std::thread::spawn(move || raw(port, "POST", "/api/groups", &host, &[("x-atlas-token", &t)], json!({ "name": n, "ids": [] }).to_string().as_bytes()).status));
    }
    let st: Vec<u16> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(st, [vec![200; 12], vec![201; 3]].concat());
    let saved: Value = serde_json::from_str(&fs::read_to_string(e.notes.join("groups.json")).unwrap()).unwrap();
    let mut names: Vec<&str> = saved["groups"].as_array().unwrap().iter().map(|g| g["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, vec!["g", "h1", "h2", "h3"]);
    assert_eq!(saved["groups"][0]["ids"].as_array().unwrap().len(), 12);
    assert!(fs::read_dir(&e.notes).unwrap().all(|x| !x.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
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
    sleep(20);
    fs::write(e.out.join("atlas.html"), atlas_html(true)).unwrap();
    assert_eq!(e.get("/api/state").0, 403);
    assert_eq!(e.json("POST", "/api/groups", Some(json!({ "name": "a", "ids": [] }))).0, 403);
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
    assert_eq!(b["current"], json!({ "path": logs.to_string_lossy(), "name": "logs" }));
    assert_eq!(b["local"], json!({ "status": "idle", "url": null }));
    assert_eq!(b["folders"], json!([]));
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
    assert_eq!(j.post(json!({ "kind": "judge", "limit": 1, "backend": "copilot-cli" })).0, 409);
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
    assert_eq!(j.post(json!({ "kind": "judge", "limit": 3, "backend": "copilot-cli" })).0, 202);
    assert_eq!(j.args(1), vec!["judge-flow".to_string(), "--limit".into(), "3".into(), "--backend".into(), "copilot-cli".into(), "--out".into(), out.clone(), "--notes-dir".into(), notes.clone()]);
    j.child(1).exit(Some(1));
    j.wait_not_running();
    let c = j.current();
    assert_eq!((c["kind"].clone(), c["state"].clone(), c["exitCode"].clone(), c["target"].clone()), (json!("judge"), json!("failed"), json!(1), json!({ "limit": 3, "backend": "copilot-cli" })));
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
        (json!({ "kind": "judge", "backend": "copilot-cli" }), 400),
        (json!({ "kind": "judge", "limit": -1, "backend": "copilot-cli" }), 400),
        (json!({ "kind": "judge", "limit": 501, "backend": "copilot-cli" }), 400),
        (json!({ "kind": "judge", "limit": 1.5, "backend": "copilot-cli" }), 400),
        (json!({ "kind": "judge", "limit": "10", "backend": "copilot-cli" }), 400),
        (json!({ "kind": "judge", "limit": 10, "backend": null }), 400),
        (json!({ "kind": "judge", "limit": 10, "backend": "" }), 400),
        (json!({ "kind": "judge", "limit": 10, "backend": "anthropic" }), 400),
        (json!({ "kind": "judge", "limit": 10, "backend": "copilot-cli; calc" }), 400),
        (json!({ "kind": "judge", "limit": 10, "backend": "copilot-cli", "only": "s1" }), 400),
        (json!({ "kind": "full" }), 400),
        (json!({ "kind": "bundle", "perPart": 2 }), 400),
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
    let p = |v: Value| parse_job_request(v.as_object().unwrap(), &|_| true);
    assert_eq!(p(json!({ "kind": "judge", "limit": 0, "backend": "copilot-cli" })), Ok(crate::jobs::JobRequest::Judge { limit: 0, backend: "copilot-cli".into() }));
    assert_eq!(p(json!({ "kind": "judge", "limit": 10 })), Ok(crate::jobs::JobRequest::Judge { limit: 10, backend: "copilot-cli".into() }));
    assert_eq!(p(json!({ "kind": "judge", "limit": 500, "backend": "copilot-cli" })), Ok(crate::jobs::JobRequest::Judge { limit: 500, backend: "copilot-cli".into() }));
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
    assert_eq!(j.args(1), vec!["export".to_string(), "--out".into(), out, "--notes-dir".into(), notes]);
    j.child(1).exit(Some(0));
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
        json!({ "exists": true, "generatedAt": "2026-11-05T00:00:00.000Z", "unjudgedOnly": true, "count": 2, "parts": [{ "path": "bundle/parts/part-01.md", "name": "part-01.md", "sessions": 2, "judged": 0, "bytes": 30 }], "canAutomate": cfg!(windows) })
    );
    assert_eq!(j.e.json("GET", "/api/judge/parts/part-01.md", None).1, json!({ "name": "part-01.md", "text": "# 指示\nパケット s1 s2" }));
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
    let pv = j.e.json("GET", "/api/jobs/judge-preview", None).1;
    assert_eq!((pv["eligible"].clone(), pv["judged"].clone(), pv["pending"].clone()), (json!(2), json!(1), json!(1)));
    assert_eq!(j.e.get("/api/judge/parts").0, 403);
}

#[test]
fn jobs_need_token_origin_host_and_not_anonymized() {
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
    fs::write(j.e.out.join("atlas.html"), atlas_html(true)).unwrap();
    j.start(|_| {});
    assert_eq!(j.post(json!({ "kind": "refresh" })).0, 403);
    assert_eq!(j.e.json("GET", "/api/jobs/current", None).0, 403);
    assert_eq!(j.e.json("GET", "/api/view/s1?kind=transcript", None).0, 403);
    assert_eq!(j.e.req("GET", "/view/s1?kind=transcript", None, &[], b"").status, 403);
    assert_eq!(j.e.req("GET", "/api/session-tools.js", None, &[], b"").status, 403);
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
fn judge_preview_counts_and_model() {
    let mut j = JobEnv::new();
    j.start(|_| {});
    let cfg = j.e.dir.join("atlas.config.json");
    assert_eq!(j.e.json("GET", "/api/jobs/judge-preview", None).1, json!({ "eligible": 2, "judged": 0, "pending": 2, "model": null, "byok": false, "modelError": null }));
    fs::write(&cfg, json!({ "judgeModel": "anthropic/claude-sonnet-5-5" }).to_string()).unwrap();
    let pv = j.e.json("GET", "/api/jobs/judge-preview", None).1;
    assert_eq!((pv["pending"].clone(), pv["model"].clone(), pv["byok"].clone(), pv["modelError"].clone()), (json!(2), json!("anthropic/claude-sonnet-5-5"), json!(true), Value::Null));
    fs::write(&cfg, "{ broken").unwrap();
    let pv = j.e.json("GET", "/api/jobs/judge-preview", None).1;
    assert_eq!((pv["model"].clone(), pv["byok"].clone()), (Value::Null, json!(false)));
    assert!(pv["modelError"].as_str().unwrap().contains("atlas.config.json を読めません"));
    fs::write(&cfg, "{}").unwrap();
    fs::write(j.e.out.join("judgments.json"), json!({ "schemaVersion": 1, "items": [{ "sessionId": "s1" }, { "sessionId": "zzz" }] }).to_string()).unwrap();
    let pv = j.e.json("GET", "/api/jobs/judge-preview", None).1;
    assert_eq!((pv["eligible"].clone(), pv["judged"].clone(), pv["pending"].clone()), (json!(2), json!(1), json!(1)));
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

// ---------- group-export.test.ts の serve の部分 ----------

#[test]
fn group_export_api_needs_token_and_releases_lock() {
    let mut e = Env::new();
    fs::create_dir_all(&e.notes).unwrap();
    fs::write(e.out.join("sessions.json"), json!({ "sessions": [] }).to_string()).unwrap();
    fs::write(e.notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "調査: A/B", "note": "", "ids": ["s1"] }] }).to_string()).unwrap();
    e.start(|_| {});
    let path = format!("/api/groups/{}/export", encode_uri_component("調査: A/B"));
    assert_eq!(e.req("POST", &path, None, &[], b"").status, 403);
    let ok = e.json("POST", &path, None);
    assert_eq!(ok.0, 200);
    assert_eq!((ok.1["name"].clone(), ok.1["sessions"].clone(), ok.1["missing"].clone()), (json!("調査: A/B"), json!(0), json!(1)));
    assert_eq!(e.json("POST", &format!("/api/groups/{}/export", encode_uri_component("無い")), None).0, 404);
    assert!(!e.out.join(JOB_LOCK_FILE).exists());
}


