//! V8 の Array.prototype.sort(TimSort)と同じ並べ方。比べ方が一貫しない(a と b を入れ替えても同じ符号を返す)比較関数を
//! TS 版が使っているところで、並びを TS 版と同じにするために使う(一貫した比較関数なら sort_by と同じ結果)。
//! 64 件未満は V8 と同じく、先頭の連(降順なら反転)を数えてから二分挿入で並べる。64 件以上は安定ソート(この長さで一貫しない比較関数は使っていない)。

use std::cmp::Ordering;

pub fn js_sort_by<T>(v: &mut [T], mut cmp: impl FnMut(&T, &T) -> Ordering) {
    let n = v.len();
    if n < 2 {
        return;
    }
    if n >= 64 {
        v.sort_by(cmp);
        return;
    }
    // CountAndMakeRun(0, n)
    let mut run = 2;
    let descending = cmp(&v[1], &v[0]) == Ordering::Less;
    for i in 2..n {
        let o = cmp(&v[i], &v[i - 1]);
        if descending {
            if o != Ordering::Less {
                break;
            }
        } else if o == Ordering::Less {
            break;
        }
        run += 1;
    }
    if descending {
        v[..run].reverse();
    }
    // BinaryInsertionSort(0, run, n)
    for start in run..n {
        let (mut left, mut right) = (0, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if cmp(&v[start], &v[mid]) == Ordering::Less {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        v[left..=start].rotate_right(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consistent_comparator_is_stable_sort() {
        let mut a = vec![(3, 'a'), (1, 'b'), (3, 'c'), (2, 'd'), (1, 'e')];
        let mut b = a.clone();
        js_sort_by(&mut a, |x, y| x.0.cmp(&y.0));
        b.sort_by(|x, y| x.0.cmp(&y.0));
        assert_eq!(a, b);
    }

    #[test]
    fn inconsistent_comparator_like_v8() {
        // transcript.ts の役の並べ方: 本体どうしは常に -1(V8 では先頭の 2 件が降順の連とみなされて反転する)
        let cmp = |a: &(&str, i32), b: &(&str, i32)| if a.0 == "本体" { Ordering::Less } else if b.0 == "本体" { Ordering::Greater } else { a.0.cmp(b.0).then(b.1.cmp(&a.1)) };
        let mut v = vec![("本体", 1), ("本体", 2)];
        js_sort_by(&mut v, cmp);
        assert_eq!(v, [("本体", 2), ("本体", 1)]);
        let mut v = vec![("本体", 1), ("本体", 2), ("本体", 3), ("x", 1)];
        js_sort_by(&mut v, cmp);
        assert_eq!(v, [("本体", 3), ("本体", 2), ("本体", 1), ("x", 1)]);
    }
}
