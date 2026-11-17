//! JavaScript の数値の書き方(`Number#toFixed`)。ログの「1.23 MB」「4.5 秒」を TS 版と同じにするため。

/// `x.toFixed(digits)`。JS は x の正確な値に最も近いものを選び、ちょうど中間なら大きいほうにする
/// (Rust の `{:.N}` は中間を偶数側に丸めるので、0.125 が 0.12 になる。JS は 0.13)
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return if x.is_nan() { "NaN".into() } else if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    // JS は 1e21 以上を指数で書く(toString と同じ)
    if x.abs() >= 1e21 {
        let mut b = ryu_js::Buffer::new();
        return b.format_finite(x).to_string();
    }
    let neg = x < 0.0;
    // double は有限の 2 進小数なので、十分な桁数で書けば正確な 10 進の値になる
    let exact = format!("{:.1100}", x.abs());
    let (int_part, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits_vec: Vec<u8> = int_part.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    let round_up = frac.as_bytes().get(digits).is_some_and(|&d| d >= b'5');
    if round_up {
        let mut i = digits_vec.len();
        loop {
            if i == 0 {
                digits_vec.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_vec[i] == 9 {
                digits_vec[i] = 0;
            } else {
                digits_vec[i] += 1;
                break;
            }
        }
    }
    let s: String = digits_vec.iter().map(|d| (b'0' + d) as char).collect();
    let (i, f) = s.split_at(s.len() - digits);
    let body = if digits == 0 { i.to_string() } else { format!("{i}.{f}") };
    // JS は -0.00 のような結果も "-0.00" と書く(x が負なら符号を付ける。-0 は付けない)
    if neg { format!("-{body}") } else { body }
}

#[cfg(test)]
mod tests {
    use super::to_fixed;

    #[test]
    fn like_js() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00"); // 1.005 の正確な値は 1.00499…
        assert_eq!(to_fixed(0.0, 2), "0.00");
        assert_eq!(to_fixed(13.75, 1), "13.8");
        assert_eq!(to_fixed(999.96, 1), "1000.0");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-1.25, 1), "-1.3");
        assert_eq!(to_fixed(123.456, 2), "123.46");
    }
}
