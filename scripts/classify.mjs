// 공고 한 건을 학생용으로 분류합니다.
//  - "특성화" : 특성화고·마이스터고·직업계고·고졸 제한경쟁 전형으로 보이는 공고
//  - "고졸가능": 학력 조건에 고졸(또는 학력무관)이 있어 고졸자도 지원할 수 있는 공고
//  - null     : 학생 대상이 아님(제외)
//
// 판단 근거는 제목과 응시자격 글만 씁니다. 우대조건의 "고졸자·고졸인재"는 가산점 항목이라
// 전형으로 보지 않고 "고졸우대" 태그로만 붙입니다.

const TITLE = /고졸|특성화\s*고|마이스터\s*고|직업계\s*고/;
const QUAL = [
  /특성화\s*고/, /마이스터\s*고/, /직업계\s*고/, /산업\s*수요\s*맞춤형\s*고/,
  /고졸\s*(제한|전형|채용|공채|수준)/,
  /고등학교\s*(졸업|재학)\s*(예정)?\s*자?\s*(만|에\s*한|대상)/,
  /최종\s*학력\s*이?\s*고(등학교|졸)/,
  /학교장\s*추천/,
];
const PREF_HIGH = /고졸\s*(자|인재|학력)|고등학교\s*졸업자/;

const eduOk = (edu) => !edu || /고졸|학력무관/.test(edu); // 학력 정보가 없으면(상세 미수집) 일단 통과

export function classify(job) {
  if (!eduOk(job.education)) return null;
  if (TITLE.test(job.title || '') || QUAL.some((re) => re.test(job.qualification || ''))) return '특성화';
  return '고졸가능';
}

// 학생에게 맞지 않는 공고(경력 전용) 걸러내기
export function isStudentFriendly(job) {
  return !(job.recruitType && job.recruitType.trim() === '경력');
}

// 화면에 보여줄 짧은 태그
export function tagsOf(job) {
  const tags = [];
  const h = job.hireType || '';
  if (/(^|[^비])정규직/.test(h)) tags.push('정규직');
  if (/무기계약/.test(h)) tags.push('무기계약');
  if (/체험형/.test(h)) tags.push('체험형인턴');
  if (/채용형/.test(h)) tags.push('채용형인턴');
  if (/비정규|(^|[^무기])계약직/.test(h)) tags.push('계약직');
  if (job.replacement) tags.push('대체인력');
  if (PREF_HIGH.test(job.preference || '')) tags.push('고졸우대');
  return tags;
}
