#!/usr/bin/env node
// 공공기관 고졸·특성화고 채용공고 수집기
//
// 1순위: 공공데이터포털 "재정경제부_공공기관 채용정보 조회서비스" 오픈API
//        (환경변수 DATA_GO_KR_KEY 에 인증키가 있을 때)
// 2순위: 인증키가 없거나 API 오류일 때 잡알리오(job.alio.go.kr) 공개 목록을 읽음
//
// 결과: docs/data/jobs.json  (학생용 페이지가 이 파일을 읽어 화면에 보여줌)
//
// 사용법:  node scripts/collect.mjs            (자동 선택)
//          node scripts/collect.mjs --source=web   (공개 목록만)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, isStudentFriendly, tagsOf } from './classify.mjs';
import { extractCerts } from './certs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/data/jobs.json');
const API = 'https://apis.data.go.kr/1051000/recruitment/list';
const WEB = 'https://job.alio.go.kr';
const EDU_HIGH = 'R7030'; // 학력조건 코드: 고졸
const UA = 'Mozilla/5.0 (compatible; school-career-board/1.0)';
const MAX_DETAIL_FETCH = Number(process.env.MAX_DETAIL_FETCH || 1000);

const args = new Set(process.argv.slice(2));
// 키 순서와 상관없이 같은 내용인지 비교하기 위한 문자열
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayKST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
const ymd = (s) => {
  if (!s) return '';
  const m = String(s).replace(/\D/g, '');
  if (m.length === 8) return `${m.slice(0, 4)}-${m.slice(4, 6)}-${m.slice(6, 8)}`;
  if (m.length === 6) return `20${m.slice(0, 2)}-${m.slice(2, 4)}-${m.slice(4, 6)}`;
  return '';
};
const clean = (s) =>
  String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
const short = (s, n = 400) => { const t = clean(s); return t.length > n ? t.slice(0, n) + '…' : t; };

async function getText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

// ───────── 1) 공공데이터포털 오픈API ─────────
async function fromApi(key) {
  const jobs = [];
  let page = 1, total = Infinity;
  while ((page - 1) * 100 < total && page <= 30) {
    const qs = new URLSearchParams({
      serviceKey: key, resultType: 'json', numOfRows: '100', pageNo: String(page),
      acbgCondLst: EDU_HIGH, ongoingYn: 'Y',
    });
    const body = await getText(`${API}?${qs}`);
    let data;
    try { data = JSON.parse(body); } catch { throw new Error('API 응답이 JSON이 아님: ' + body.slice(0, 200)); }
    if (String(data.resultCode) !== '200') throw new Error(`API 오류 ${data.resultCode} ${data.resultMsg}`);
    total = Number(data.totalCount || 0);
    for (const r of data.result || []) {
      jobs.push({
        id: String(r.recrutPblntSn),
        org: r.instNm,
        title: clean(r.recrutPbancTtl),
        education: r.acbgCondNmLst || '',
        hireType: r.hireTypeNmLst || '',
        recruitType: r.recrutSeNm || '',
        region: r.workRgnNmLst || '',
        ncs: r.ncsCdNmLst || '',
        headcount: r.recrutNope ? Number(r.recrutNope) : null,
        start: ymd(r.pbancBgngYmd),
        end: ymd(r.pbancEndYmd),
        replacement: r.replmprYn === 'Y',
        qualification: short(r.aplyQlfcCn, 300),
        preference: short([r.prefCondCn, r.prefCn].filter(Boolean).join(' / '), 200),
        url: r.srcUrl || '',
        certs: extractCerts([r.recrutPbancTtl, r.aplyQlfcCn, r.prefCondCn, r.prefCn, r.scrnprcdrMthdExpln].join(' ')),
      });
    }
    page++;
    await sleep(300);
  }
  return { jobs, source: 'api' };
}

// ───────── 2) 잡알리오 공개 목록 (인증키 없이) ─────────
function parseList(html) {
  const rows = [];
  const re = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html))) {
    const tr = m[1];
    const idm = tr.match(/recruitview\.do\?idx=(\d+)/);
    if (!idm) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    rows.push({
      id: idm[1],
      title: clean(tr.match(/recruitview\.do\?idx=\d+"[^>]*>([\s\S]*?)<\/a>/)?.[1]),
      org: clean(tds[3]),
      region: clean(tds[4]).replace(/\s+/g, ' '),
      hireType: clean(tds[5]),
      start: ymd(clean(tds[6])),
      end: ymd(clean(tds[7]).split(/\s/)[0]),
    });
  }
  return rows;
}

function parseDetail(html) {
  const field = (name) => {
    const m = html.match(new RegExp(`<th>\\s*${name}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
    return m ? clean(m[1]) : '';
  };
  const section = (name) => {
    const m = html.match(new RegExp(`<h4>\\s*${name}\\s*</h4>\\s*<p[^>]*>([\\s\\S]*?)</p>`));
    return m ? m[1] : '';
  };
  const url = clean(html.match(/공고 URL\s*:?[\s\S]{0,200}?href="([^"]+)"/)?.[1] || '');
  const head = field('채용인원').match(/\d+/);
  return {
    education: field('학력정보'),
    recruitType: field('채용구분'),
    hireType: field('고용형태'),
    region: field('근무지'),
    ncs: field('표준직무\\(NCS\\)'),
    headcount: head ? Number(head[0]) : null,
    replacement: /^예/.test(field('대체인력여부')),
    qualification: short(section('응시자격'), 300),
    preference: short([field('우대조건'), section('우대내용')].filter(Boolean).join(' / '), 200),
    url,
    // 자격증은 잘라내기 전 전체 글에서 뽑음
    certs: extractCerts([section('응시자격'), field('우대조건'), section('우대내용'), section('전형절차/방법')].map(clean).join(' ')),
  };
}

async function fromWeb(prevById, skipIds) {
  const list = [];
  for (let page = 1; page <= 40; page++) {
    const html = await getText(`${WEB}/recruit.do?pageNo=${page}&pageSet=50&ing=2&education=${EDU_HIGH}`);
    const rows = parseList(html);
    if (!rows.length) break;
    list.push(...rows);
    if (rows.length < 50) break;
    await sleep(700);
  }
  let fetched = 0;
  const jobs = [];
  const skipped = [];
  for (const row of list) {
    if (skipIds.has(row.id)) { skipped.push(row); continue; } // 전에 학생용이 아니라고 판단한 공고는 다시 읽지 않음
    const prev = prevById.get(row.id);
    let detail;
    if (prev && prev._detail && Array.isArray(prev.certs)) {
      detail = prev; // 이미 받아 둔 상세정보 재사용 (사이트 부담 줄이기)
    } else if (fetched < MAX_DETAIL_FETCH) {
      try {
        detail = { ...parseDetail(await getText(`${WEB}/recruitview.do?idx=${row.id}`)), _detail: true };
      } catch (e) {
        console.warn('상세 실패', row.id, e.message);
        detail = {};
      }
      fetched++;
      await sleep(600);
    } else detail = {};
    jobs.push({ ...detail, ...row, region: detail.region || row.region, hireType: detail.hireType || row.hireType, _detail: !!detail._detail });
  }
  console.log(`공개 목록 ${list.length}건, 상세 새로 받음 ${fetched}건`);
  return { jobs, skipped, source: 'web' };
}

// ───────── 실행 ─────────
async function main() {
  let prev = { jobs: [] };
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const prevById = new Map((prev.jobs || []).map((j) => [j.id, j]));

  const key = process.env.DATA_GO_KR_KEY?.trim();
  let result;
  if (key && !args.has('--source=web')) {
    try { result = await fromApi(key); }
    catch (e) { console.warn('API 실패 → 공개 목록으로 대체:', e.message); }
  }
  if (!result) result = await fromWeb(prevById, new Set(prev.excluded || []));

  const today = todayKST();
  const firstSeen = new Map((prev.jobs || []).map((j) => [j.id, j.firstSeen]));
  const jobs = result.jobs
    .filter((j) => !j.end || j.end >= today)
    .filter(isStudentFriendly)
    .map((j) => ({
      ...j,
      track: classify(j),
      tags: tagsOf(j),
      alioUrl: `${WEB}/recruitview.do?idx=${j.id}`,
      firstSeen: firstSeen.get(j.id) || today,
    }))
    .filter((j) => j.track)
    .sort((a, b) => (a.track === b.track ? (a.end || '9').localeCompare(b.end || '9') : a.track === '특성화' ? -1 : 1));

  // 결과가 0건이면 사이트 장애일 가능성이 커서 기존 파일을 지키고 실패 처리
  if (!jobs.length && (prev.jobs || []).length) {
    console.error('수집 결과 0건 — 기존 데이터를 유지합니다.');
    process.exit(1);
  }

  // 학생용이 아니라서 뺀 공고 번호(다음 실행 때 상세를 다시 읽지 않으려고 저장)
  const keptIds = new Set(jobs.map((j) => j.id));
  const excluded = [...result.jobs.filter((j) => !keptIds.has(j.id) && (!j.end || j.end >= today)), ...(result.skipped || [])]
    .map((j) => j.id).sort();

  // 공고 내용이 지난번과 같으면 파일을 건드리지 않음 → 커밋도 생기지 않음
  if (stable(jobs) === stable(prev.jobs || []) && stable(excluded) === stable(prev.excluded || [])) {
    console.log(`변경 없음 (공고 ${jobs.length}건 그대로)`);
    return;
  }

  const out = {
    updatedAt: new Date().toISOString(),
    source: result.source,
    counts: {
      total: jobs.length,
      special: jobs.filter((j) => j.track === '특성화').length,
      highschool: jobs.filter((j) => j.track === '고졸가능').length,
    },
    jobs,
    excluded,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`저장: ${OUT}\n출처=${out.source} 전체 ${out.counts.total} (특성화·고졸전형 ${out.counts.special}, 고졸 지원가능 ${out.counts.highschool})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
