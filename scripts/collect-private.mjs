#!/usr/bin/env node
// 대기업·중견기업 고졸 생산·기술직 공고 수집기 (고용24 공개 채용검색)
//
// 고용24 채용검색에서 [기업형태: 대기업, 중견기업] + [학력: 고졸]로 공고를 받고,
// 제목·모집직종으로 생산·설비·정비·전기·기계·용접·품질 같은 기술직만 남깁니다.
// 상세 페이지에서 자격요건·우대조건 글을 읽어 자격증 이름을 뽑습니다.
//
// 결과: docs/data/private.json
// 사용법:  node scripts/collect-private.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCerts } from './certs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/data/private.json');
const BASE = 'https://www.work24.go.kr';
const UA = 'Mozilla/5.0 (compatible; school-career-board/1.0)';
const COMPANY_TYPES = { '01': '대기업', '20': '중견기업' };
const MAX_DETAIL_FETCH = Number(process.env.MAX_DETAIL_FETCH || 500);

// 기술·생산직으로 볼 말 / 빼야 할 말
const TECH = /생산|제조|기능직|현장직|오퍼레이터|operator|설비|정비|보전|메인터넌스|maintenance|기계|전기|전자|용접|배관|공조|냉동|보일러|에너지|유틸리티|품질|검사|조립|가공|도장|프레스|사출|CNC|금형|반도체|배터리|화학|공정|플랜트|시설관리|기술직|엔지니어|생산직|교대/i;
const NON_TECH = /사무|총무|회계|경리|영업|판매|캐셔|계산원|매장|PT\s*사원|파트너|미화|청소|조리|주방|콜센터|상담|보험|설계사|간호|요양|경비|주차|배송|택배|운전기사|홍보|마케팅|디자인|강사|교사|모델|리셉션|프론트|객실|서빙|피킹|포장|진열/i;

// 키 순서와 상관없이 같은 내용인지 비교하기 위한 문자열
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const clean = (s) =>
  String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\r]+/g, ' ').replace(/\n\s*/g, '\n').trim();
const short = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n) + '…' : t; };

async function getText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

function parseList(html, companyType) {
  const rows = [];
  for (const m of html.matchAll(/<tr id="list\d+">([\s\S]*?)<\/tr>/g)) {
    const tr = m[1];
    const link = tr.match(/href="(\/wk\/a\/b\/1500\/empDetailAuthView\.do\?wantedAuthNo=([^&"]+)[^"]*)"/);
    if (!link) continue;
    const href = link[1].replace(/&amp;/g, '&');
    const member = [...(tr.match(/<li class="member">([\s\S]*?)<\/li>/)?.[1] || '').matchAll(/<span class="item sm">([\s\S]*?)<\/span>/g)].map((x) => clean(x[1]).replace(/\s+/g, ' '));
    rows.push({
      id: link[2],
      company: clean(tr.match(/class="cp_name[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1]),
      companyType,
      labels: [...tr.matchAll(/<span class="tbl_label[^"]*">([^<]+)<\/span>/g)].map((x) => x[1].trim()),
      title: clean(tr.match(/data-emp-detail[^>]*>([\s\S]*?)<\/a>/)?.[1]),
      pay: clean(tr.match(/<li class="dollar">([\s\S]*?)<\/li>/)?.[1]).replace(/\s+/g, ' '),
      career: member[0] || '',
      education: member[1] || '',
      region: clean(tr.match(/<li class="site">([\s\S]*?)<\/li>/)?.[1]).replace(/\s+/g, ' '),
      end: tr.match(/마감일\s*:\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '',
      start: tr.match(/등록일\s*:\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '',
      source: clean(tr.match(/alt="정보제공처\s*([^"]+)"/)?.[1]) || '고용24',
      url: BASE + href,
    });
  }
  return rows;
}

function parseDetail(html) {
  const th = (name) => {
    const m = html.match(new RegExp(`<th[^>]*>\\s*${name}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
    return m ? clean(m[1]) : '';
  };
  // 상세 본문(모집요강~안내문 앞)만 잘라 자격증을 찾음
  const a = html.indexOf('모집요강');
  const b = html.indexOf('선택하신 채용정보에 포함된');
  const body = clean(html.slice(a > 0 ? a : 0, b > a ? b : a + 40000));
  const licence = th('자격\\s*면허');
  const pref = [th('우대조건'), th('기타\\s*우대사항'), th('전공')].filter((x) => x && x !== '-').join(' / ');
  return {
    job: th('모집\\s*직종'),
    headcount: (th('모집\\s*인원').match(/\d+/) || [])[0] ? Number(th('모집\\s*인원').match(/\d+/)[0]) : null,
    licence: licence && licence !== '관계없음' && licence !== '-' ? licence : '',
    preference: short(pref, 200),
    summary: short(body.replace(/^모집요강\s*/, ''), 300),
    certs: extractCerts([licence, pref, body].join(' ')),
  };
}

async function main() {
  let prev = { jobs: [] };
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const prevById = new Map((prev.jobs || []).map((j) => [j.id, j]));

  const list = [];
  for (const [code, name] of Object.entries(COMPANY_TYPES)) {
    for (let page = 1; page <= 30; page++) {
      const qs = `resultCnt=50&sortField=DATE&sortOrderBy=DESC&currentPageNo=${page}&pageIndex=${page}&enterPriseGbn=${code}&academicGbn=03&empTpGbcd=1&siteClcd=all`;
      const rows = parseList(await getText(`${BASE}/wk/a/b/1200/retriveDtlEmpSrchList.do?${qs}`), name);
      if (!rows.length) break;
      list.push(...rows);
      await sleep(800);
      if (rows.length < 50) break;
    }
  }
  const uniq = [...new Map(list.map((r) => [r.id, r])).values()];
  const tech = uniq.filter((r) => TECH.test(r.title) && !NON_TECH.test(r.title));
  console.log(`대기업·중견 고졸 공고 ${uniq.length}건 → 생산·기술직 ${tech.length}건`);

  let fetched = 0;
  const jobs = [];
  const excluded = [];
  const skipIds = new Set(prev.excluded || []);
  for (const r of tech) {
    if (skipIds.has(r.id)) { excluded.push(r.id); continue; } // 전에 뺀 공고는 다시 읽지 않음
    let d = prevById.get(r.id);
    if (!d || !d._detail) {
      if (fetched >= MAX_DETAIL_FETCH) d = {};
      else {
        try { d = { ...parseDetail(await getText(r.url)), _detail: true }; } catch (e) { console.warn('상세 실패', r.id, e.message); d = {}; }
        fetched++;
        await sleep(800);
      }
    }
    // 모집직종이 사무·판매 쪽이면 제외
    if (d.job && NON_TECH.test(d.job) && !TECH.test(d.job)) { excluded.push(r.id); continue; }
    jobs.push({
      ...r,
      job: d.job || '', headcount: d.headcount ?? null, licence: d.licence || '',
      preference: d.preference || '', summary: d.summary || '', certs: d.certs || [], _detail: !!d._detail,
      firstSeen: prevById.get(r.id)?.firstSeen || todayKST(),
    });
  }
  const today = todayKST();
  const live = jobs.filter((j) => !j.end || j.end >= today).sort((a, b) => (a.end || '9').localeCompare(b.end || '9'));
  if (!live.length && (prev.jobs || []).length) { console.error('수집 결과 0건 — 기존 데이터를 유지합니다.'); process.exit(1); }

  excluded.sort();
  if (stable(live) === stable(prev.jobs || []) && stable(excluded) === stable(prev.excluded || [])) {
    console.log(`변경 없음 (공고 ${live.length}건 그대로)`);
    return;
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), source: 'work24-web', counts: { total: live.length }, jobs: live, excluded }));
  console.log(`상세 새로 받음 ${fetched}건, 저장 ${live.length}건 → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
