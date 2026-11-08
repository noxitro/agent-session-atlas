import '../styles/base.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { DATA_ELEMENT_ID } from '../lib/embed.ts';
import { unpackData } from '../lib/pack.ts';
import type { ReportData } from '../lib/types.ts';

function readData(): { data: ReportData | null; error: string | null } {
  const el = document.getElementById(DATA_ELEMENT_ID);
  if (!el || !el.textContent) return { data: null, error: 'レポートのデータが埋め込まれていません。' };
  try {
    const raw = JSON.parse(el.textContent) as ReportData;
    if (!raw || !Array.isArray(raw.sessions)) return { data: null, error: '埋め込みデータの形が想定と違います(sessions がありません)。' };
    // セッションの要約は既定値と同じ項目を落として埋め込んであるので、埋め戻す(lib/pack.ts)
    return { data: unpackData(raw), error: null };
  } catch (e) {
    return { data: null, error: `埋め込みデータを読めません: ${(e as Error).message}。atlas build で生成し直してください。` };
  }
}

const { data, error } = readData();
mount(App, { target: document.getElementById('app')!, props: { data, error } });
