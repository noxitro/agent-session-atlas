//! 版の文字列の形(build.rs と version.rs の両方が使う。build.rs は #[path] でこのファイルを読むので、依存を足さない)。

/// semver の形(`1.2.3`、`1.2.3-rc.1`、`1.2.3+build.5`)か。先頭の v や空白は付けない。数の部分に余計な 0 を付けない(`01.2.3` は違う)
pub fn is_semver(s: &str) -> bool {
    let (core, build) = match s.split_once('+') {
        Some((c, b)) => (c, Some(b)),
        None => (s, None),
    };
    let (nums, pre) = match core.split_once('-') {
        Some((n, p)) => (n, Some(p)),
        None => (core, None),
    };
    let parts: Vec<&str> = nums.split('.').collect();
    let numeric = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && (p == "0" || !p.starts_with('0'));
    let ident = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    parts.len() == 3 && parts.iter().all(|p| numeric(p)) && pre.is_none_or(|p| p.split('.').all(ident)) && build.is_none_or(|b| b.split('.').all(ident))
}

#[cfg(test)]
mod tests {
    use super::is_semver;

    #[test]
    fn accepts_semver_and_rejects_the_rest() {
        for ok in ["0.1.0", "0.1.12", "10.20.30", "1.0.0-rc.1", "1.0.0-alpha-2", "1.0.0+build.5", "1.0.0-rc.1+sha.abc"] {
            assert!(is_semver(ok), "{ok}");
        }
        for bad in ["", "v0.1.0", "0.1", "0.1.0.1", "01.2.3", "0.1.x", " 0.1.0", "0.1.0 ", "0.1.0-", "0.1.0+", "0.1.0-rc..1", "0.1.0-rc_1"] {
            assert!(!is_semver(bad), "{bad}");
        }
    }
}
