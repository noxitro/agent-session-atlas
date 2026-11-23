//! 管理ツールが書き出した XML から、タスク(ID・名前・状態)を読む。書き出しの形は管理ツールごとに違うので、読み方は設定で決める。
//! - タスク 1 件 = 名前(名前空間を除いた名前。大文字と小文字は区別しない)が item の要素。入れ子になっていても、当たる要素はすべてタスク
//! - 項目(ID・名前・状態)は、その名前の属性か、子の要素の文字。名前の前に @ を付けると属性だけを見る。付けなければ属性、次に子の要素(属性が空なら子の要素)
//! - DTD は読まない(DOCTYPE があれば読めないものとして止める)。外部の実体も読まない。ファイルの大きさにも上限を置く
//! - ID が空のタスクは飛ばす。同じ ID が 2 回あれば先のものを使う(数は知らせる)

use roxmltree::{Document, Node, ParsingOptions};
use std::path::Path;

/// 読む XML の大きさの上限(バイト)
pub const XML_SIZE_LIMIT: u64 = 64 * 1024 * 1024;
/// 読む節の数の上限を決める、ファイルの大きさあたりの数(バイト数 ÷ これ)。roxmltree が数える節は、要素・文字(要素の間の
/// 改行と字下げの空白も 1 つ)・コメント・処理命令と文書の根で、属性は数えない。字下げした書き出しで 1 件に子の要素が 30 ほどあると、
/// 1 つの節はおよそ 13 バイト、値が 1 文字の項目ばかりでも 5 バイトほど(テストで測る)。これより細かいものは書き出しの形ではないとみなして読まない。
/// 64 MB で 1,600 万ほどの節になり、メモリはファイルの大きさに比例する分だけ使う
pub const BYTES_PER_NODE_MIN: usize = 4;
/// 小さいファイルでも許す節の数
const NODES_FLOOR: usize = 100_000;

/// このファイルの大きさで許す節の数
pub fn nodes_limit_for(bytes: usize) -> u32 {
    (bytes / BYTES_PER_NODE_MIN).max(NODES_FLOOR).min(u32::MAX as usize) as u32
}
/// 項目の長さの上限(文字。超えた分は切る)
pub const ID_MAX: usize = 200;
pub const NAME_MAX: usize = 500;
pub const STATUS_MAX: usize = 100;

/// 項目の読み方
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Field {
    /// 属性だけ(設定で @ を付けたもの)
    Attr(String),
    /// 属性、無ければ子の要素
    Either(String),
}

impl Field {
    pub fn parse(spec: &str) -> Field {
        let s = atlas_core::js::trim(spec);
        match s.strip_prefix('@') {
            Some(a) => Field::Attr(a.to_lowercase()),
            None => Field::Either(s.to_lowercase()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmlSpec {
    pub item: String,
    pub id: Field,
    pub name: Field,
    pub status: Field,
}

impl XmlSpec {
    pub fn of(s: &super::TaskSource) -> XmlSpec {
        XmlSpec { item: atlas_core::js::trim(&s.item).to_lowercase(), id: Field::parse(&s.id), name: Field::parse(&s.name), status: Field::parse(&s.status) }
    }
}

/// XML の 1 件
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmlTask {
    pub id: String,
    pub name: String,
    pub status: String,
}

/// 読んだ結果
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct XmlRead {
    pub tasks: Vec<XmlTask>,
    /// item に当たった要素の数
    pub items: usize,
    /// ID が空で飛ばした数
    pub empty_id: usize,
    /// 同じ ID の 2 回目以降で飛ばした数
    pub duplicates: usize,
    /// 長すぎて切った項目の数
    pub truncated: usize,
}

impl XmlRead {
    /// 読んだときの注意(CLI と画面に出す)
    pub fn notes(&self) -> Vec<String> {
        let mut v = Vec::new();
        if self.items == 0 {
            v.push("タスクの要素が 1 つもありません(設定の tasks.item を確かめてください)".to_string());
        }
        if self.empty_id > 0 {
            v.push(format!("ID が空のタスク {} 件を飛ばしました(設定の tasks.id を確かめてください)", self.empty_id));
        }
        if self.duplicates > 0 {
            v.push(format!("同じ ID のタスクが {} 件あり、先に出たものを使いました", self.duplicates));
        }
        if self.truncated > 0 {
            v.push(format!("長すぎる項目 {} 個を切り詰めました", self.truncated));
        }
        v
    }
}

/// 名前が同じか(want は小文字にしたもの)
fn eq_name(name: &str, want: &str) -> bool {
    name.eq_ignore_ascii_case(want) || name.to_lowercase() == want
}

fn attr(node: Node<'_, '_>, name: &str) -> Option<String> {
    node.attributes().find(|a| eq_name(a.name(), name)).map(|a| a.value().to_string())
}

/// 要素の中の文字(子孫の文字をつなげたもの)
fn text_of(node: Node<'_, '_>) -> String {
    node.descendants().filter(|d| d.is_text()).filter_map(|d| d.text()).collect()
}

fn child_text(node: Node<'_, '_>, name: &str) -> Option<String> {
    node.children().find(|c| c.is_element() && eq_name(c.tag_name().name(), name)).map(text_of)
}

fn field_value(node: Node<'_, '_>, f: &Field) -> Option<String> {
    match f {
        Field::Attr(n) => attr(node, n),
        // 属性が空(前後の空白だけ)なら子の要素を見る
        Field::Either(n) => attr(node, n).filter(|v| !v.trim().is_empty()).or_else(|| child_text(node, n)),
    }
}

/// 前後の空白を除き、続いた空白(改行を含む)を 1 つにして、max 文字で切る。切ったら true
fn clean(s: &str, max: usize) -> (String, bool) {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() > max {
        (joined.chars().take(max).collect(), true)
    } else {
        (joined, false)
    }
}

/// XML の文字列からタスクを読む。XML として読めなければ理由
pub fn parse_tasks_xml(text: &str, spec: &XmlSpec) -> Result<XmlRead, String> {
    let opt = ParsingOptions { allow_dtd: false, nodes_limit: nodes_limit_for(text.len()), ..ParsingOptions::default() };
    let doc = Document::parse_with_options(text, opt).map_err(|e| match e {
        roxmltree::Error::DtdDetected => "DTD(<!DOCTYPE …>)のある XML は読みません".to_string(),
        e => format!("XML として読めません({e})"),
    })?;
    let mut out = XmlRead::default();
    let mut seen = std::collections::HashSet::new();
    for node in doc.descendants().filter(|n| n.is_element() && eq_name(n.tag_name().name(), &spec.item)) {
        out.items += 1;
        let (id, cut_id) = clean(&field_value(node, &spec.id).unwrap_or_default(), ID_MAX);
        if id.is_empty() {
            out.empty_id += 1;
            continue;
        }
        if !seen.insert(id.clone()) {
            out.duplicates += 1;
            continue;
        }
        let (name, cut_name) = clean(&field_value(node, &spec.name).unwrap_or_default(), NAME_MAX);
        let (status, cut_status) = clean(&field_value(node, &spec.status).unwrap_or_default(), STATUS_MAX);
        out.truncated += [cut_id, cut_name, cut_status].iter().filter(|x| **x).count();
        out.tasks.push(XmlTask { id, name, status });
    }
    Ok(out)
}

/// バイト列を文字列に(UTF-8。先頭に BOM があれば UTF-16 も読む)
fn decode(bytes: &[u8]) -> Result<String, String> {
    let utf16 = |be: bool| -> Result<String, String> {
        let units: Vec<u16> = bytes[2..].as_chunks::<2>().0.iter().map(|c| if be { u16::from_be_bytes(*c) } else { u16::from_le_bytes(*c) }).collect();
        String::from_utf16(&units).map_err(|_| "UTF-16 として読めません".to_string())
    };
    match bytes {
        [0xFF, 0xFE, ..] => utf16(false),
        [0xFE, 0xFF, ..] => utf16(true),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8(rest.to_vec()).map_err(|_| "UTF-8 として読めません".to_string()),
        _ => String::from_utf8(bytes.to_vec()).map_err(|_| "UTF-8 として読めません(管理ツールから UTF-8 か UTF-16 で書き出してください)".to_string()),
    }
}

/// XML のファイルを読む。返すのは読んだ結果と、ファイルの更新時刻(ミリ秒。読んだ時点の観測の時刻に使う)。
/// 読めなければ理由(画面と CLI に出す。前に読んだタスクの状態はそのまま残す)
pub fn read_tasks_file(path: &Path, spec: &XmlSpec) -> Result<(XmlRead, i64), String> {
    let shown = path.display();
    let meta = std::fs::metadata(path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { format!("タスクの XML がありません: {shown}") } else { format!("タスクの XML を開けません: {shown}({e})") })?;
    if !meta.is_file() {
        return Err(format!("タスクの XML がファイルではありません: {shown}"));
    }
    if meta.len() > XML_SIZE_LIMIT {
        return Err(format!("タスクの XML が大きすぎます({} MB。上限 {} MB): {shown}", meta.len() / 1024 / 1024, XML_SIZE_LIMIT / 1024 / 1024));
    }
    let mtime = atlas_core::jsfs::mtime_ms(&meta).floor() as i64;
    let bytes = std::fs::read(path).map_err(|e| format!("タスクの XML を読めません: {shown}({e})"))?;
    let text = decode(&bytes).map_err(|e| format!("タスクの XML を読めません: {shown}({e})"))?;
    let read = parse_tasks_xml(&text, spec).map_err(|e| format!("タスクの XML を読めません: {shown}({e})"))?;
    Ok((read, mtime))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(item: &str, id: &str, name: &str, status: &str) -> XmlSpec {
        XmlSpec { item: item.to_lowercase(), id: Field::parse(id), name: Field::parse(name), status: Field::parse(status) }
    }

    fn def() -> XmlSpec {
        spec("Task", "Id", "Name", "Status")
    }

    fn ids(r: &XmlRead) -> Vec<&str> {
        r.tasks.iter().map(|t| t.id.as_str()).collect()
    }

    #[test]
    fn child_elements_and_attributes() {
        let x = r#"<?xml version="1.0" encoding="UTF-8"?>
<Tasks>
  <Task><Id>T-1</Id><Name>  画面の
     一覧を直す </Name><Status>Open</Status></Task>
  <Task Id="T-2" Name="属性だけのタスク" Status="Done"/>
  <Task id="T-3"><NAME>大文字の要素</NAME><status>Closed</status></Task>
</Tasks>"#;
        let r = parse_tasks_xml(x, &def()).unwrap();
        assert_eq!(
            r.tasks,
            vec![
                XmlTask { id: "T-1".into(), name: "画面の 一覧を直す".into(), status: "Open".into() },
                XmlTask { id: "T-2".into(), name: "属性だけのタスク".into(), status: "Done".into() },
                XmlTask { id: "T-3".into(), name: "大文字の要素".into(), status: "Closed".into() },
            ]
        );
        assert_eq!(r.items, 3);
        assert!(r.notes().is_empty());
    }

    #[test]
    fn attribute_first_and_forced_attribute() {
        let x = r#"<r><task key="A"><key>子の値</key><title>名前</title><state>Open</state></task></r>"#;
        // 属性があれば属性
        let r = parse_tasks_xml(x, &spec("task", "key", "title", "state")).unwrap();
        assert_eq!(ids(&r), ["A"]);
        // @ は属性だけ。子の要素は見ない
        let r = parse_tasks_xml(x, &spec("task", "key", "@title", "state")).unwrap();
        assert_eq!(r.tasks[0].name, "");
        let r = parse_tasks_xml(r#"<r><task><key>B</key></task></r>"#, &spec("task", "@key", "title", "state")).unwrap();
        assert_eq!((r.tasks.len(), r.empty_id), (0, 1));
    }

    /// 属性が空なら子の要素を見る(@ を付けたときは属性だけ)
    #[test]
    fn empty_attribute_falls_back_to_child() {
        let x = r#"<r><Task Id=" " Name=""><Id>C-1</Id><Name>子の名前</Name></Task></r>"#;
        let r = parse_tasks_xml(x, &def()).unwrap();
        assert_eq!((r.tasks[0].id.as_str(), r.tasks[0].name.as_str()), ("C-1", "子の名前"));
        let r = parse_tasks_xml(x, &spec("Task", "Id", "@Name", "Status")).unwrap();
        assert_eq!(r.tasks[0].name, "");
    }

    /// 節の数の上限を超える XML は読まない
    #[test]
    fn node_limit() {
        // 節が細かすぎる(1 つが 4 バイトより小さい)XML は読まない
        let dense = format!("<r>{}</r>", "<a/>x".repeat(NODES_FLOOR));
        assert!(parse_tasks_xml(&dense, &def()).unwrap_err().starts_with("XML として読めません"));
        // 属性は節に数えない(要素 1 つと根で 2)
        let doc = Document::parse(r#"<a x="1" y="2" z="3"/>"#).unwrap();
        assert_eq!(doc.descendants().count(), 2);
        // 要素の間の改行と字下げ・要素の中の文字は、どれも 1 つの節
        let doc = Document::parse("<a>\n  <b>t</b>\n</a>").unwrap();
        assert_eq!(doc.descendants().count(), 6);
    }

    /// 字下げした書き出し(1 件に子の要素が 30)で、64 MB まで読める節の数があるか
    #[test]
    fn realistic_exports_fit_the_node_limit() {
        let fields: String = (0..30).map(|i| format!("\n      <Field{i}>value of field {i}</Field{i}>")).collect();
        let one = format!("\n    <Task>\n      <Id>T-1</Id>{fields}\n    </Task>");
        let text = format!("<?xml version=\"1.0\"?>\n<Export>\n  <Tasks>{}\n  </Tasks>\n</Export>\n", one.repeat(2_000));
        let doc = Document::parse_with_options(&text, ParsingOptions { nodes_limit: u32::MAX, ..ParsingOptions::default() }).unwrap();
        let nodes = doc.descendants().count();
        let per_node = text.len() / nodes;
        assert!(per_node >= BYTES_PER_NODE_MIN * 3, "1 つの節が {per_node} バイト");
        assert!(parse_tasks_xml(&text, &def()).is_ok());
        // 64 MB の同じ形の書き出しの節の数が、上限に収まる
        let full = (XML_SIZE_LIMIT as usize / text.len()) * nodes;
        assert!((full as u64) < nodes_limit_for(XML_SIZE_LIMIT as usize) as u64, "{full}");
        // 値が 1 文字の項目ばかりで、字下げの無い書き出しでも収まる
        let short: String = (0..30).map(|i| format!("<F{i}>1</F{i}>")).collect();
        let tight = format!("<Export>{}</Export>", format!("<Task><Id>T</Id>{short}</Task>").repeat(2_000));
        let doc = Document::parse_with_options(&tight, ParsingOptions { nodes_limit: u32::MAX, ..ParsingOptions::default() }).unwrap();
        assert!(tight.len() / doc.descendants().count() > BYTES_PER_NODE_MIN, "{}", tight.len() / doc.descendants().count());
        assert!(parse_tasks_xml(&tight, &def()).is_ok());
    }

    #[test]
    fn namespaces_are_ignored() {
        let x = r#"<p:Export xmlns:p="urn:example:tasks" xmlns:q="urn:example:fields">
  <p:WorkItem q:Ref="W-10" q:Title="名前空間つき"><q:State>完了</q:State></p:WorkItem>
  <WorkItem xmlns="urn:example:default"><Ref>W-11</Ref><Title>既定の名前空間</Title><State>進行中</State></WorkItem>
</p:Export>"#;
        let r = parse_tasks_xml(x, &spec("workitem", "Ref", "Title", "State")).unwrap();
        assert_eq!(ids(&r), ["W-10", "W-11"]);
        assert_eq!(r.tasks[0].status, "完了");
        assert_eq!(r.tasks[1].name, "既定の名前空間");
    }

    #[test]
    fn nested_items_are_tasks_too() {
        let x = r#"<Tasks><Task><Id>P-1</Id><Name>親</Name><Status>Open</Status>
  <Children><Task><Id>P-1-1</Id><Name>子</Name><Status>Done</Status></Task></Children>
</Task></Tasks>"#;
        let r = parse_tasks_xml(x, &def()).unwrap();
        assert_eq!(ids(&r), ["P-1", "P-1-1"]);
        // 親の名前は自分の子の要素だけから取る(入れ子のタスクの Name と混ざらない)
        assert_eq!(r.tasks[0].name, "親");
        assert_eq!(r.tasks[1].status, "Done");
    }

    #[test]
    fn empty_ids_duplicates_and_long_values() {
        let long = "あ".repeat(NAME_MAX + 5);
        let x = format!(r#"<Tasks><Task Id=" " Name="x"/><Task Id="D-1" Name="先"/><Task Id="D-1" Name="後"/><Task Id="D-2" Name="{long}"/></Tasks>"#);
        let r = parse_tasks_xml(&x, &def()).unwrap();
        assert_eq!(ids(&r), ["D-1", "D-2"]);
        assert_eq!(r.tasks[0].name, "先");
        assert_eq!(r.tasks[1].name.chars().count(), NAME_MAX);
        assert_eq!((r.empty_id, r.duplicates, r.truncated), (1, 1, 1));
        let notes = r.notes();
        assert_eq!(notes.len(), 3, "{notes:?}");
        let none = parse_tasks_xml("<Tasks><Item/></Tasks>", &def()).unwrap();
        assert!(none.notes()[0].contains("tasks.item"));
    }

    #[test]
    fn bad_xml_and_dtd_are_refused() {
        assert!(parse_tasks_xml("<Tasks><Task>", &def()).unwrap_err().starts_with("XML として読めません"));
        assert!(parse_tasks_xml("", &def()).is_err());
        let bomb = r#"<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><Tasks><Task Id="&b;"/></Tasks>"#;
        assert!(parse_tasks_xml(bomb, &def()).unwrap_err().contains("DTD"));
        let external = r#"<?xml version="1.0"?><!DOCTYPE r SYSTEM "http://example.invalid/x.dtd"><Tasks/>"#;
        assert!(parse_tasks_xml(external, &def()).unwrap_err().contains("DTD"));
        // 決まった実体と文字の参照は読む
        let r = parse_tasks_xml(r#"<Tasks><Task Id="E-1" Name="a &amp; b &#x3042;"/></Tasks>"#, &def()).unwrap();
        assert_eq!(r.tasks[0].name, "a & b あ");
    }

    /// e2e でも使う架空の書き出し(e2e/fixtures/tasks/)。要素の形と属性・名前空間の形で、同じタスクが読める
    #[test]
    fn shared_fixtures() {
        let before = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../e2e/fixtures/tasks/export-before.xml"));
        let after = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../e2e/fixtures/tasks/export-after.xml"));
        let attrs = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../e2e/fixtures/tasks/export-attributes.xml"));
        let b = parse_tasks_xml(before, &def()).unwrap();
        assert_eq!(ids(&b), ["DEMO-101", "DEMO-102", "DEMO-102-1", "DEMO-103", "DEMO-104", "DEMO-106"]);
        assert!(b.notes().is_empty());
        let a = parse_tasks_xml(after, &def()).unwrap();
        assert_eq!(ids(&a), ["DEMO-101", "DEMO-102", "DEMO-102-1", "DEMO-103", "DEMO-104", "DEMO-105"]);
        let x = parse_tasks_xml(attrs, &spec("WorkItem", "@key", "Title", "State")).unwrap();
        assert_eq!(ids(&x), ["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104", "DEMO-105"]);
        let named = |r: &XmlRead| r.tasks.iter().filter(|t| t.id != "DEMO-102-1").map(|t| (t.id.clone(), t.name.clone())).collect::<Vec<_>>();
        assert_eq!(named(&x), named(&a));
        assert_eq!(x.tasks[0].status, "Resolved");
    }

    #[test]
    fn files_utf16_size_and_missing() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("export.xml");
        let text = r#"<?xml version="1.0" encoding="UTF-16"?><Tasks><Task Id="U-1" Name="UTF-16 の書き出し" Status="Open"/></Tasks>"#;
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(text.encode_utf16().flat_map(|u| u.to_le_bytes()));
        std::fs::write(&p, bytes).unwrap();
        let (r, mtime) = read_tasks_file(&p, &def()).unwrap();
        assert_eq!(r.tasks[0].name, "UTF-16 の書き出し");
        assert!(mtime > 0);
        std::fs::write(&p, "\u{feff}<Tasks><Task Id=\"B-1\"/></Tasks>").unwrap();
        assert_eq!(ids(&read_tasks_file(&p, &def()).unwrap().0), ["B-1"]);
        std::fs::write(&p, [0x3C, 0x82, 0xA0, 0x3E]).unwrap();
        assert!(read_tasks_file(&p, &def()).unwrap_err().contains("UTF-8"));
        assert!(read_tasks_file(&d.path().join("none.xml"), &def()).unwrap_err().starts_with("タスクの XML がありません"));
        assert!(read_tasks_file(d.path(), &def()).unwrap_err().contains("ファイルではありません"));
    }
}
