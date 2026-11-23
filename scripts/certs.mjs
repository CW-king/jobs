// 공고문 글에서 자격증 이름을 뽑아냅니다.
// 국가기술자격(기능사·산업기사·기사·기능장·기술사)과 자주 나오는 몇 가지 자격을 찾습니다.

const GRADE = '(기능장|산업기사|기술사|기능사|기사)';
const NAMED = /(컴퓨터활용능력\s*[1-2]?\s*급?|워드프로세서|정보처리[가-힣]*|한국사능력검정[가-힣]*|위험물[가-힣]{0,6}|소방안전관리자\s*[1-3]?\s*급?|ITQ|GTQ|지게차|굴착기|[1-2]\s*종\s*(대형|보통)\s*(운전)?\s*면허|운전면허)/g;

// 자격증이 아닌데 "~기사"로 끝나는 말
const NOT_CERT = /^(운전|관련|신문|버스|택시|배송|화물|해당|분야|동일|이상|국가|기술|자격|각종|기능|전문|정비|현장|외부|홍보|보도|기획|생산|직무|각|및|또는|등|의|해당분야|관련분야)$/;

function normalize(s) {
  return s.replace(/\s+/g, '').replace(/^[·\-–,./]+/, '');
}

export function extractCerts(text) {
  if (!text) return [];
  let t = String(text)
    .replace(/&nbsp;/g, ' ')
    // "전기(산업)기사" → "전기기사, 전기산업기사"
    .replace(/([가-힣]{2,12})\s*\(\s*산업\s*\)\s*기사/g, '$1기사, $1산업기사')
    // "용접기능사/산업기사" → "용접기능사, 용접산업기사"
    .replace(/([가-힣]{2,12})(기능사|산업기사|기사)\s*[\/·,]\s*(기능사|산업기사|기사)(?![가-힣])/g, '$1$2, $1$3');

  const found = new Set();
  const re = new RegExp(`([가-힣A-Za-z]{2,16}?)\\s?${GRADE}(?![가-힣])`, 'g');
  let m;
  while ((m = re.exec(t))) {
    let name = m[1];
    // 앞에 붙은 조사·꾸밈말 떼기 (예: "및전기기능사" → "전기기능사")
    name = name.replace(/^(및|또는|등|의|각|관련|해당|소지자|우대|자격증|자격|이상|분야)+/, '');
    if (name.length < 2 || NOT_CERT.test(name)) continue;
    found.add(normalize(name + m[2]));
  }
  for (const n of t.matchAll(NAMED)) {
    let v = normalize(n[0]);
    if (/^지게차$/.test(v)) v = '지게차운전기능사';
    if (/^굴착기$/.test(v)) v = '굴착기운전기능사';
    if (/운전면허$/.test(v) && !/종/.test(v)) v = '운전면허';
    found.add(v);
  }
  const fix = (c) =>
    c
      .replace(/^(\d)종(대형|보통)(운전)?면허$/, '$1종$2운전면허')
      .replace(/^컴퓨터활용능력(\d)$/, '컴퓨터활용능력$1급')
      .replace(/^한국사능력검정(시험)?.*$/, '한국사능력검정시험')
      .replace(/^위험물(산업)?기능사?$/, (x) => x);
  return [...new Set([...found].map(fix))].filter(isCert).sort();
}

// 자격증처럼 보이지만 직무 이름인 것(예: "수리기사", "전기교대기사") 걸러내기
const JOB_WORDS = /^(산업기사|기능사|기능장|기술사|정보처리|국가기술자격.*|수리기사|중장비기사|산업기능사|에너지기능사|방재기사|시설기사|설비기사|영선기사|.*교대기사|.*당직기사|.*상주기사|.*현장기사|.*주임기사|시설관리기사|건물관리기사)$/;
export function isCert(c) {
  return c.length >= 4 && !JOB_WORDS.test(c);
}
