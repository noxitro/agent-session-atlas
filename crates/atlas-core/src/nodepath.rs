//! Node の `path.win32` / `path.posix` の移植(normalize・join・resolve・relative・isAbsolute・dirname・basename)。
//! ログに残ったパス(別の PC・別の OS のもの)を TS 版と同じ形にそろえるため、ファイルシステムは見ずに文字列だけで決める。
//! Node 24 の lib/path.js と同じ手順(区切りなどはすべて ASCII なので、位置は UTF-8 のバイトで数える)。
//! resolve の基準(process.cwd())は引数で渡す。

const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "COM\u{b9}", "COM\u{b2}", "COM\u{b3}",
    "LPT\u{b9}", "LPT\u{b2}", "LPT\u{b3}",
];

fn is_sep(c: u8) -> bool {
    c == b'/' || c == b'\\'
}

fn is_posix_sep(c: u8) -> bool {
    c == b'/'
}

fn is_device_root(c: u8) -> bool {
    c.is_ascii_alphabetic()
}

/// `isWindowsReservedName(path, colonIndex)`。colon が None(-1)なら JS の slice(0, -1) と同じく最後の 1 文字を除く
fn is_reserved(path: &str, colon: Option<usize>) -> bool {
    let part = match colon {
        Some(i) => &path[..i],
        None => match path.char_indices().last() {
            Some((i, _)) => &path[..i],
            None => "",
        },
    };
    let up = part.to_uppercase();
    WINDOWS_RESERVED_NAMES.contains(&up.as_str())
}

/// lib/path.js の normalizeString
fn normalize_string(path: &str, allow_above_root: bool, separator: char, is_separator: fn(u8) -> bool) -> String {
    let b = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u8 = 0;
    let len = b.len();
    let mut i = 0usize;
    while i <= len {
        if i < len {
            code = b[i];
        } else if is_separator(code) {
            break;
        } else {
            code = b'/';
        }
        if is_separator(code) {
            if last_slash == i as isize - 1 || dots == 1 {
                // 何もしない
            } else if dots == 2 {
                let rb = res.as_bytes();
                if res.len() < 2 || last_segment_length != 2 || rb[rb.len() - 1] != b'.' || rb[rb.len() - 2] != b'.' {
                    if res.len() > 2 {
                        match res.rfind(separator) {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(idx) => {
                                res.truncate(idx);
                                last_segment_length = res.len() as isize - 1 - res.rfind(separator).map_or(-1, |x| x as isize);
                            }
                        }
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if res.is_empty() {
                        res.push_str("..");
                    } else {
                        res.push(separator);
                        res.push_str("..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let seg = &path[(last_slash + 1) as usize..i];
                if !res.is_empty() {
                    res.push(separator);
                }
                res.push_str(seg);
                last_segment_length = i as isize - last_slash - 1;
            }
            last_slash = i as isize;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

pub mod posix {
    use super::*;

    pub fn is_absolute(p: &str) -> bool {
        p.as_bytes().first() == Some(&b'/')
    }

    pub fn normalize(p: &str) -> String {
        if p.is_empty() {
            return ".".into();
        }
        let b = p.as_bytes();
        let abs = b[0] == b'/';
        let trailing = b[b.len() - 1] == b'/';
        let mut s = normalize_string(p, !abs, '/', is_posix_sep);
        if s.is_empty() {
            if abs {
                return "/".into();
            }
            return if trailing { "./".into() } else { ".".into() };
        }
        if trailing {
            s.push('/');
        }
        if abs { format!("/{s}") } else { s }
    }

    pub fn join(parts: &[&str]) -> String {
        let mut joined: Option<String> = None;
        for a in parts {
            if a.is_empty() {
                continue;
            }
            match &mut joined {
                None => joined = Some((*a).to_string()),
                Some(j) => {
                    j.push('/');
                    j.push_str(a);
                }
            }
        }
        match joined {
            None => ".".into(),
            Some(j) => normalize(&j),
        }
    }

    /// `path.posix.resolve(...parts)`。どれも絶対パスでなければ cwd を前に足す
    pub fn resolve(parts: &[&str], cwd: &str) -> String {
        let mut resolved = String::new();
        let mut abs = false;
        let mut i = parts.len() as isize - 1;
        while i >= -1 && !abs {
            let p = if i >= 0 { parts[i as usize] } else { cwd };
            i -= 1;
            if p.is_empty() {
                continue;
            }
            resolved = format!("{p}/{resolved}");
            abs = p.as_bytes()[0] == b'/';
        }
        let r = normalize_string(&resolved, !abs, '/', is_posix_sep);
        if abs {
            return format!("/{r}");
        }
        if r.is_empty() { ".".into() } else { r }
    }

    pub fn relative(from: &str, to: &str, cwd: &str) -> String {
        if from == to {
            return String::new();
        }
        let from = resolve(&[from], cwd);
        let to = resolve(&[to], cwd);
        if from == to {
            return String::new();
        }
        let fb = from.as_bytes();
        let tb = to.as_bytes();
        let from_start = 1usize;
        let from_end = fb.len();
        let from_len = from_end - from_start;
        let to_start = 1usize;
        let to_len = tb.len() - to_start;
        let length = from_len.min(to_len);
        let mut last_common_sep: isize = -1;
        let mut i = 0usize;
        while i < length {
            let fc = fb[from_start + i];
            if fc != tb[to_start + i] {
                break;
            } else if fc == b'/' {
                last_common_sep = i as isize;
            }
            i += 1;
        }
        if i == length {
            if to_len > length {
                if tb[to_start + i] == b'/' {
                    return to[to_start + i + 1..].to_string();
                }
                if i == 0 {
                    return to[to_start + i..].to_string();
                }
            } else if from_len > length {
                if fb[from_start + i] == b'/' {
                    last_common_sep = i as isize;
                } else if i == 0 {
                    last_common_sep = 0;
                }
            }
        }
        let mut out = String::new();
        let mut k = (from_start as isize + last_common_sep + 1) as usize;
        while k <= from_end {
            if k == from_end || fb[k] == b'/' {
                out.push_str(if out.is_empty() { ".." } else { "/.." });
            }
            k += 1;
        }
        format!("{out}{}", &to[(to_start as isize + last_common_sep) as usize..])
    }

    pub fn dirname(p: &str) -> String {
        if p.is_empty() {
            return ".".into();
        }
        let b = p.as_bytes();
        let has_root = b[0] == b'/';
        let mut end: isize = -1;
        let mut matched_slash = true;
        let mut i = b.len() as isize - 1;
        while i >= 1 {
            if b[i as usize] == b'/' {
                if !matched_slash {
                    end = i;
                    break;
                }
            } else {
                matched_slash = false;
            }
            i -= 1;
        }
        if end == -1 {
            return if has_root { "/".into() } else { ".".into() };
        }
        if has_root && end == 1 {
            return "//".into();
        }
        p[..end as usize].to_string()
    }

    pub fn basename(p: &str) -> String {
        let b = p.as_bytes();
        let mut start = 0usize;
        let mut end: isize = -1;
        let mut matched_slash = true;
        let mut i = b.len() as isize - 1;
        while i >= 0 {
            if b[i as usize] == b'/' {
                if !matched_slash {
                    start = i as usize + 1;
                    break;
                }
            } else if end == -1 {
                matched_slash = false;
                end = i + 1;
            }
            i -= 1;
        }
        if end == -1 {
            return String::new();
        }
        p[start..end as usize].to_string()
    }
}

pub mod win32 {
    use super::*;

    pub fn is_absolute(p: &str) -> bool {
        let b = p.as_bytes();
        if b.is_empty() {
            return false;
        }
        is_sep(b[0]) || (b.len() > 2 && is_device_root(b[0]) && b[1] == b':' && is_sep(b[2]))
    }

    pub fn normalize(path: &str) -> String {
        let b = path.as_bytes();
        let len = b.len();
        if len == 0 {
            return ".".into();
        }
        let mut root_end = 0usize;
        let mut device: Option<String> = None;
        let mut is_abs = false;
        let code = b[0];
        if len == 1 {
            return if is_posix_sep(code) { "\\".into() } else { path.to_string() };
        }
        if is_sep(code) {
            is_abs = true;
            if is_sep(b[1]) {
                let mut j = 2;
                let mut last = j;
                while j < len && !is_sep(b[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let first_part = &path[last..j];
                    last = j;
                    while j < len && is_sep(b[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_sep(b[j]) {
                            j += 1;
                        }
                        if j == len || j != last {
                            if first_part == "." || first_part == "?" {
                                device = Some(format!("\\\\{first_part}"));
                                root_end = 4;
                                let colon = path.find(':');
                                let end = colon.map_or(0, |c| c + 1);
                                let possible = if end >= 4 { &path[4..end] } else { "" };
                                let pd_colon = possible.char_indices().last().map(|(i, _)| i);
                                if !possible.is_empty() && is_reserved(possible, pd_colon) {
                                    device = Some(format!("\\\\?\\{possible}"));
                                    root_end = 4 + possible.len();
                                }
                            } else if j == len {
                                return format!("\\\\{first_part}\\{}\\", &path[last..]);
                            } else {
                                device = Some(format!("\\\\{first_part}\\{}", &path[last..j]));
                                root_end = j;
                            }
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else if let Some(colon) = path.find(':').filter(|&c| c > 0) {
            if is_device_root(code) && colon == 1 {
                device = Some(path[..2].to_string());
                root_end = 2;
                if len > 2 && is_sep(b[2]) {
                    is_abs = true;
                    root_end = 3;
                }
            } else if is_reserved(path, Some(colon)) {
                device = Some(path[..colon + 1].to_string());
                root_end = colon + 1;
            }
        }
        let mut tail = if root_end < len { normalize_string(&path[root_end..], !is_abs, '\\', is_sep) } else { String::new() };
        if tail.is_empty() && !is_abs {
            tail = ".".into();
        }
        if !tail.is_empty() && is_sep(b[len - 1]) {
            tail.push('\\');
        }
        if !is_abs && device.is_none() && path.contains(':') {
            let tb = tail.as_bytes();
            if tb.len() >= 2 && is_device_root(tb[0]) && tb[1] == b':' {
                return format!(".\\{tail}");
            }
            let mut idx = path.find(':');
            while let Some(i) = idx {
                if i == len - 1 || is_sep(b[i + 1]) {
                    return format!(".\\{tail}");
                }
                idx = path[i + 1..].find(':').map(|k| k + i + 1);
            }
        }
        if is_reserved(path, path.find(':')) {
            return format!(".\\{}{tail}", device.as_deref().unwrap_or(""));
        }
        match device {
            None => {
                if is_abs {
                    format!("\\{tail}")
                } else {
                    tail
                }
            }
            Some(d) => {
                if is_abs {
                    format!("{d}\\{tail}")
                } else {
                    format!("{d}{tail}")
                }
            }
        }
    }

    pub fn join(parts: &[&str]) -> String {
        let path: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
        if path.is_empty() {
            return ".".into();
        }
        let first = path[0].as_bytes();
        let mut joined = path.join("\\");
        let mut needs_replace = true;
        let mut slash_count = 0usize;
        if is_sep(first[0]) {
            slash_count += 1;
            if first.len() > 1 && is_sep(first[1]) {
                slash_count += 1;
                if first.len() > 2 {
                    if is_sep(first[2]) {
                        slash_count += 1;
                    } else {
                        needs_replace = false;
                    }
                }
            }
        }
        if needs_replace {
            let jb = joined.as_bytes();
            while slash_count < jb.len() && is_sep(jb[slash_count]) {
                slash_count += 1;
            }
            if slash_count >= 2 {
                joined = format!("\\{}", &joined[slash_count..]);
            }
        }
        // 予約されたデバイス名を含むときは整えない
        let reserved = joined.split('\\').filter(|p| !p.is_empty()).any(|p| p.find(':').is_some_and(|c| is_reserved(p, Some(c))));
        if reserved {
            return joined.replace('/', "\\");
        }
        normalize(&joined)
    }

    /// `path.win32.resolve(...parts)`。cwd は process.cwd() の代わり(ドライブごとの作業フォルダの環境変数は見ない)
    pub fn resolve(parts: &[&str], cwd: &str) -> String {
        let mut resolved_device = String::new();
        let mut resolved_tail = String::new();
        let mut resolved_abs = false;
        let mut i = parts.len() as isize - 1;
        while i >= -1 {
            let path: String;
            if i >= 0 {
                let p = parts[i as usize];
                i -= 1;
                if p.is_empty() {
                    continue;
                }
                path = p.to_string();
            } else if resolved_device.is_empty() {
                i -= 1;
                path = cwd.to_string();
            } else {
                i -= 1;
                let c = cwd;
                let cb = c.as_bytes();
                path = if c.len() >= 2 && c[..2].to_lowercase() != resolved_device.to_lowercase() && cb.get(2) == Some(&b'\\') { format!("{resolved_device}\\") } else { c.to_string() };
            }
            let b = path.as_bytes();
            let len = b.len();
            let mut root_end = 0usize;
            let mut device = String::new();
            let mut is_abs = false;
            let code = b[0];
            if len == 1 {
                if is_sep(code) {
                    root_end = 1;
                    is_abs = true;
                }
            } else if is_sep(code) {
                is_abs = true;
                if is_sep(b[1]) {
                    let mut j = 2;
                    let mut last = j;
                    while j < len && !is_sep(b[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        let first_part = &path[last..j];
                        last = j;
                        while j < len && is_sep(b[j]) {
                            j += 1;
                        }
                        if j < len && j != last {
                            last = j;
                            while j < len && !is_sep(b[j]) {
                                j += 1;
                            }
                            if j == len || j != last {
                                if first_part != "." && first_part != "?" {
                                    device = format!("\\\\{first_part}\\{}", &path[last..j]);
                                    root_end = j;
                                } else {
                                    device = format!("\\\\{first_part}");
                                    root_end = 4;
                                }
                            }
                        }
                    }
                } else {
                    root_end = 1;
                }
            } else if is_device_root(code) && b[1] == b':' {
                device = path[..2].to_string();
                root_end = 2;
                if len > 2 && is_sep(b[2]) {
                    is_abs = true;
                    root_end = 3;
                }
            }
            if !device.is_empty() {
                if !resolved_device.is_empty() {
                    if device.to_lowercase() != resolved_device.to_lowercase() {
                        continue;
                    }
                } else {
                    resolved_device = device;
                }
            }
            if resolved_abs {
                if !resolved_device.is_empty() {
                    break;
                }
            } else {
                resolved_tail = format!("{}\\{resolved_tail}", &path[root_end..]);
                resolved_abs = is_abs;
                if is_abs && !resolved_device.is_empty() {
                    break;
                }
            }
        }
        let tail = normalize_string(&resolved_tail, !resolved_abs, '\\', is_sep);
        if resolved_abs {
            format!("{resolved_device}\\{tail}")
        } else {
            let s = format!("{resolved_device}{tail}");
            if s.is_empty() { ".".into() } else { s }
        }
    }

    pub fn relative(from: &str, to: &str, cwd: &str) -> String {
        if from == to {
            return String::new();
        }
        let from_orig = resolve(&[from], cwd);
        let to_orig = resolve(&[to], cwd);
        if from_orig == to_orig {
            return String::new();
        }
        let from = from_orig.to_lowercase();
        let to = to_orig.to_lowercase();
        if from == to {
            return String::new();
        }
        if from_orig.len() != from.len() || to_orig.len() != to.len() {
            let mut fs: Vec<&str> = from_orig.split('\\').collect();
            let mut ts: Vec<&str> = to_orig.split('\\').collect();
            if fs.last() == Some(&"") {
                fs.pop();
            }
            if ts.last() == Some(&"") {
                ts.pop();
            }
            let (fl, tl) = (fs.len(), ts.len());
            let length = fl.min(tl);
            let mut i = 0;
            while i < length {
                if fs[i].to_lowercase() != ts[i].to_lowercase() {
                    break;
                }
                i += 1;
            }
            if i == 0 {
                return to_orig;
            } else if i == length {
                if tl > length {
                    return ts[i..].join("\\");
                }
                if fl > length {
                    return format!("{}..", "..\\".repeat(fl - 1 - i));
                }
                return String::new();
            }
            return format!("{}{}", "..\\".repeat(fl - i), ts[i..].join("\\"));
        }
        let fb = from.as_bytes();
        let tb = to.as_bytes();
        let mut from_start = 0usize;
        while from_start < fb.len() && fb[from_start] == b'\\' {
            from_start += 1;
        }
        let mut from_end = fb.len();
        while from_end as isize - 1 > from_start as isize && fb[from_end - 1] == b'\\' {
            from_end -= 1;
        }
        let from_len = from_end - from_start;
        let mut to_start = 0usize;
        while to_start < tb.len() && tb[to_start] == b'\\' {
            to_start += 1;
        }
        let mut to_end = tb.len();
        while to_end as isize - 1 > to_start as isize && tb[to_end - 1] == b'\\' {
            to_end -= 1;
        }
        let to_len = to_end - to_start;
        let length = from_len.min(to_len);
        let mut last_common_sep: isize = -1;
        let mut i = 0usize;
        while i < length {
            let fc = fb[from_start + i];
            if fc != tb[to_start + i] {
                break;
            } else if fc == b'\\' {
                last_common_sep = i as isize;
            }
            i += 1;
        }
        if i != length {
            if last_common_sep == -1 {
                return to_orig;
            }
        } else {
            if to_len > length {
                if tb[to_start + i] == b'\\' {
                    return to_orig[to_start + i + 1..].to_string();
                }
                if i == 2 {
                    return to_orig[to_start + i..].to_string();
                }
            }
            if from_len > length {
                if fb[from_start + i] == b'\\' {
                    last_common_sep = i as isize;
                } else if i == 2 {
                    last_common_sep = 3;
                }
            }
            if last_common_sep == -1 {
                last_common_sep = 0;
            }
        }
        let mut out = String::new();
        let mut k = (from_start as isize + last_common_sep + 1) as usize;
        while k <= from_end {
            if k == from_end || fb[k] == b'\\' {
                out.push_str(if out.is_empty() { ".." } else { "\\.." });
            }
            k += 1;
        }
        let mut ts = (to_start as isize + last_common_sep) as usize;
        if !out.is_empty() {
            return format!("{out}{}", &to_orig[ts..to_end]);
        }
        if to_orig.as_bytes().get(ts) == Some(&b'\\') {
            ts += 1;
        }
        to_orig[ts..to_end].to_string()
    }

    pub fn dirname(path: &str) -> String {
        let b = path.as_bytes();
        let len = b.len();
        if len == 0 {
            return ".".into();
        }
        let mut root_end: isize = -1;
        let mut offset = 0usize;
        let code = b[0];
        if len == 1 {
            return if is_sep(code) { path.to_string() } else { ".".into() };
        }
        if is_sep(code) {
            root_end = 1;
            offset = 1;
            if is_sep(b[1]) {
                let mut j = 2;
                let mut last = j;
                while j < len && !is_sep(b[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && is_sep(b[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_sep(b[j]) {
                            j += 1;
                        }
                        if j == len {
                            return path.to_string();
                        }
                        if j != last {
                            root_end = j as isize + 1;
                            offset = j + 1;
                        }
                    }
                }
            }
        } else if is_device_root(code) && b[1] == b':' {
            root_end = if len > 2 && is_sep(b[2]) { 3 } else { 2 };
            offset = root_end as usize;
        }
        let mut end: isize = -1;
        let mut matched_slash = true;
        let mut i = len as isize - 1;
        while i >= offset as isize {
            if is_sep(b[i as usize]) {
                if !matched_slash {
                    end = i;
                    break;
                }
            } else {
                matched_slash = false;
            }
            i -= 1;
        }
        if end == -1 {
            if root_end == -1 {
                return ".".into();
            }
            end = root_end;
        }
        path[..end as usize].to_string()
    }

    pub fn basename(path: &str) -> String {
        let b = path.as_bytes();
        let mut start = 0usize;
        let mut end: isize = -1;
        let mut matched_slash = true;
        if b.len() >= 2 && is_device_root(b[0]) && b[1] == b':' {
            start = 2;
        }
        let mut i = b.len() as isize - 1;
        while i >= start as isize {
            if is_sep(b[i as usize]) {
                if !matched_slash {
                    start = i as usize + 1;
                    break;
                }
            } else if end == -1 {
                matched_slash = false;
                end = i + 1;
            }
            i -= 1;
        }
        if end == -1 {
            return String::new();
        }
        path[start..end as usize].to_string()
    }
}

/// このプロセスの作業フォルダ(Node の process.cwd()。最初に読んだものを使い回す)
pub fn process_cwd() -> String {
    static CWD: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| std::env::current_dir().map(|p| strip_verbatim(&p.to_string_lossy())).unwrap_or_default());
    CWD.clone()
}

/// Windows の \\?\ を外す
pub fn strip_verbatim(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    s.strip_prefix(r"\\?\").unwrap_or(s).to_string()
}

/// 実行中の OS の `path`(Windows なら win32)
pub mod platform {
    use super::*;

    pub fn is_absolute(p: &str) -> bool {
        if cfg!(windows) { win32::is_absolute(p) } else { posix::is_absolute(p) }
    }
    pub fn join(parts: &[&str]) -> String {
        if cfg!(windows) { win32::join(parts) } else { posix::join(parts) }
    }
    pub fn resolve(parts: &[&str]) -> String {
        let cwd = process_cwd();
        if cfg!(windows) { win32::resolve(parts, &cwd) } else { posix::resolve(parts, &cwd) }
    }
    pub fn dirname(p: &str) -> String {
        if cfg!(windows) { win32::dirname(p) } else { posix::dirname(p) }
    }
    pub fn basename(p: &str) -> String {
        if cfg!(windows) { win32::basename(p) } else { posix::basename(p) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win32_basics() {
        assert_eq!(win32::normalize("c:/a/b/../c/"), "c:\\a\\c\\");
        assert_eq!(win32::normalize("\\\\server\\share"), "\\\\server\\share\\");
        assert_eq!(win32::normalize("C:\\"), "C:\\");
        assert_eq!(win32::resolve(&["C:\\a", "..\\b"], "D:\\x"), "C:\\b");
        assert_eq!(win32::join(&["C:\\a", "b/c"]), "C:\\a\\b\\c");
        assert_eq!(win32::relative("C:\\a", "C:\\a\\b\\c", "C:\\"), "b\\c");
        assert_eq!(win32::relative("C:\\a\\b", "C:\\a", "C:\\"), "..");
        assert_eq!(win32::relative("C:\\a", "D:\\b", "C:\\"), "D:\\b");
        assert_eq!(win32::dirname("C:\\a\\b"), "C:\\a");
        assert_eq!(win32::dirname("C:\\"), "C:\\");
        assert_eq!(win32::basename("C:\\a\\b\\"), "b");
    }

    #[test]
    fn posix_basics() {
        assert_eq!(posix::normalize("/a//b/../c/."), "/a/c");
        assert_eq!(posix::normalize("a/../.."), "..");
        assert_eq!(posix::resolve(&["/home/u", "x/../y"], "/"), "/home/u/y");
        assert_eq!(posix::join(&["a", "", "../b"]), "b");
        assert_eq!(posix::relative("/a/b", "/a/c/d", "/"), "../c/d");
        assert_eq!(posix::dirname("/a/b/"), "/a");
        assert_eq!(posix::dirname("/a"), "/");
    }

    /// Node と同じ結果か(scripts で作った期待値のファイルがあるときだけ。ATLAS_NODEPATH_CASES に場所を入れる)
    #[test]
    fn against_node_cases() {
        let Ok(p) = std::env::var("ATLAS_NODEPATH_CASES") else { return };
        let text = std::fs::read_to_string(p).unwrap();
        let cases: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
        let mut bad = Vec::new();
        for c in &cases {
            let f = c["f"].as_str().unwrap();
            let a: Vec<&str> = c["a"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
            let want = &c["r"];
            let got = match f {
                "win32.normalize" => serde_json::json!(win32::normalize(a[0])),
                "win32.join" => serde_json::json!(win32::join(&a)),
                "win32.resolve" => serde_json::json!(win32::resolve(&a, "C:\\cwd")),
                "win32.relative" => serde_json::json!(win32::relative(a[0], a[1], "C:\\cwd")),
                "win32.dirname" => serde_json::json!(win32::dirname(a[0])),
                "win32.basename" => serde_json::json!(win32::basename(a[0])),
                "win32.isAbsolute" => serde_json::json!(win32::is_absolute(a[0])),
                "posix.normalize" => serde_json::json!(posix::normalize(a[0])),
                "posix.join" => serde_json::json!(posix::join(&a)),
                "posix.resolve" => serde_json::json!(posix::resolve(&a, "/cwd")),
                "posix.relative" => serde_json::json!(posix::relative(a[0], a[1], "/cwd")),
                "posix.dirname" => serde_json::json!(posix::dirname(a[0])),
                _ => continue,
            };
            if &got != want {
                bad.push(format!("{f}({a:?}): node={want} rust={got}"));
            }
        }
        assert!(bad.is_empty(), "{} 件違う:\n{}", bad.len(), bad.join("\n"));
    }
}
