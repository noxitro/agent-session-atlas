// CSS の副作用 import(main.ts の import '../styles/base.css')は Vite がバンドルに取り込む。
// TypeScript 6 は副作用 import も型の解決先を求めるので、中身を持たないモジュールとして宣言する。
declare module '*.css';
