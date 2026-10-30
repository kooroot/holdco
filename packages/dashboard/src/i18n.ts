/**
 * The dashboard's language. English strings are the keys; `t("Inbox")` returns the Korean line
 * when the language is `ko`, else the key. `{name}` placeholders are filled from the second argument.
 * The choice is per viewer (localStorage), defaulting to the browser's language.
 */
import { useSyncExternalStore } from "react"

export type Lang = "en" | "ko"
export const LANGS: Array<[Lang, string]> = [["en", "English"], ["ko", "한국어"]]

let current: Lang = (() => {
  try { const v = localStorage.getItem("holdco.lang"); if (v === "en" || v === "ko") return v } catch { /* no storage */ }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en"
})()
const listeners = new Set<() => void>()
export const setLang = (l: Lang) => { current = l; try { localStorage.setItem("holdco.lang", l) } catch { /* ignore */ } document.documentElement.lang = l; for (const f of listeners) f() }
export const getLang = () => current
export const useLang = () => useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f) }, getLang, getLang)

export const t = (en: string, vars?: Record<string, string | number>): string => {
  const s = (current === "ko" ? KO[en] : undefined) ?? en
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : s
}

/** Plural helper: `n(count, "session", "sessions")` → "1 session" / "3 sessions" (Korean has no plural). */
export const n = (count: number, one: string, many: string) => `${count} ${t(count === 1 ? one : many)}`

const KO: Record<string, string> = {
  // nav
  "Home": "홈", "Inbox": "인박스", "Tickets": "티켓", "Audit": "감사", "Quality": "품질", "Releases": "릴리스", "Sessions & spend": "세션·지출", "Organization": "조직", "Controls": "제어", "Settings": "설정",
  "New ticket": "새 티켓", "new ticket": "새 티켓", "approve": "승인", "reject": "거절", "views": "화면", "close": "닫기", "Close": "닫기", "Edit": "편집", "Cancel": "취소",
  "connecting…": "연결 중…", "supervisor not running": "슈퍼바이저 꺼짐", "halted (L5)": "정지됨 (L5)", "unreachable: {m}": "연결 안 됨: {m}",
  "running · {n} interrupts": "실행 중 · 인터럽트 {n}", "running · {n} sessions": "실행 중 · 세션 {n}", "{a} of {b} this month": "이달 {b} 중 {a}",
  "Language": "언어",
  // home
  "decision waiting": "결정 대기", "decisions waiting": "결정 대기", "blocked tickets": "막힌 티켓", "sessions running": "실행 중 세션", "spent in 24h": "24시간 지출", "to grade · audit due": "채점 대기 · 감사 기한", "to grade": "채점 대기", "candidate under watch": "감시 중인 후보", "current release": "현재 릴리스",
  "Activity": "활동", "what the company did, newest first": "회사가 한 일, 최신순", "No activity yet": "아직 활동 없음", "Open a ticket and start the supervisor.": "티켓을 열고 슈퍼바이저를 시작하세요.",
  "Running now": "지금 실행 중", "Idle. Sessions start as tickets become ready.": "대기 중. 티켓이 준비되면 세션이 시작됩니다.", "Supervisor not running — start it with holdco supervise.": "슈퍼바이저가 꺼져 있습니다 — holdco supervise로 시작하세요.", "watch": "보기",
  "Finished in the last 24h": "최근 24시간에 끝난 일", "Nothing finished in the last day.": "지난 하루 동안 끝난 일이 없습니다.", "{t} ago": "{t} 전",
  // states / kinds
  "New": "신규", "Triaged": "분류됨", "In progress": "진행 중", "Verifying": "검증 중", "Verified": "검증됨", "Approval": "승인 대기", "Done": "완료", "Rejected": "반려", "Blocked": "막힘", "Declined": "기각", "Rolled back": "롤백됨",
  "Approval needed": "승인 필요", "COO objected": "COO 반대", "COO did not answer": "COO 무응답", "Triage": "분류", "Blocked ticket": "막힌 티켓", "Graduation proposal": "승격 제안", "Issue from an agent": "에이전트 이슈", "Run by hand": "수동 실행", "Candidate withdrawn": "후보 철회", "Recovery needed": "복구 필요",
  // inbox
  "Decisions only you can make. Unanswered items reject themselves at the deadline; urgent ones alert you at once.": "당신만 내릴 수 있는 결정. 답하지 않은 항목은 기한에 스스로 거절되고, 긴급한 것은 즉시 알립니다.",
  "{n} waiting": "{n}건 대기", "{n} waiting, {u} urgent": "{n}건 대기, 긴급 {u}", "Nothing waiting on you": "기다리는 결정 없음", "The company is working within its rules.": "회사가 규칙 안에서 일하고 있습니다.",
  "rejects itself in {t}": "{t} 후 자동 거절", "Approve": "승인", "Reject": "거절", "Ticket": "티켓", "Goal": "목표", "Branch": "브랜치", "Verdict": "판정", "{o}/4, {c} confidence — {s}": "{o}/4, 신뢰도 {c} — {s}",
  "CEO proposes:": "CEO 제안:", "Why now:": "왜 지금:", "Cost:": "비용:", "Rollback:": "롤백:", "Risk:": "위험:", "Rejected alternatives:": "기각된 대안:", "COO {d}s:": "COO {d}:",
  "note (optional; goes to the ticket and the digest)": "메모 (선택; 티켓과 다이제스트에 남음)", "Approved": "승인함", "Rejected!": "거절함",
  'Approve "{t}"? The kernel executes it on the next tick.': '"{t}" 승인할까요? 커널이 다음 틱에 실행합니다.',
  // board
  "Every piece of work, by where the kernel holds it. Blocked tickets wait on a decision.": "모든 일을 커널이 붙잡고 있는 단계별로. 막힌 티켓은 결정을 기다립니다.",
  "All departments": "모든 부서", "show done (7d)": "완료 보기 (7일)", "needs a decision": "결정 필요", "paused: {f}": "일시정지: {f}", "rejected, retrying ({n})": "반려, 재시도 ({n})",
  // audit
  "Weekly audit": "주간 감사", "Grade the sample before you see the judge's verdict. Your grades calibrate Verification; skipping two weeks freezes graduation and improvement.": "심판 판정을 보기 전에 샘플을 채점하세요. 당신의 채점이 검증을 보정하며, 두 주를 건너뛰면 승격과 개선이 멈춥니다.",
  "{g} of {n} graded · {l} labels total": "{n} 중 {g} 채점 · 레이블 총 {l}", " · agreement {a}": " · 일치율 {a}", "Finish this week's audit": "이번 주 감사 마치기", "last audit {t}": "마지막 감사 {t}", "no audit recorded yet": "아직 감사 기록 없음",
  "Nothing to grade": "채점할 것 없음", "Every recent verdict is graded. Record the audit so the week counts.": "최근 판정은 모두 채점됐습니다. 이번 주로 집계되게 감사를 기록하세요.", "Verdicts appear here once tickets have been judged.": "티켓이 판정되면 여기에 나타납니다.",
  "agree": "일치", "disagree": "불일치", "low confidence": "낮은 신뢰도", "Pick a ticket": "티켓을 고르세요", "The branch diff, the goal and the done criteria appear here.": "브랜치 diff, 목표, 완료 기준이 여기에 나옵니다.",
  "{n} sessions, {c}": "세션 {n}, {c}", "Done when": "완료 조건", "Senior said": "시니어의 말", "Diff": "Diff", "Files": "파일", "No branch to diff.": "diff할 브랜치 없음.",
  "You and the judge agree": "심판과 일치", "You disagree with the judge": "심판과 불일치", "Already graded": "이미 채점됨", "judge: {v}": "심판: {v}", "you: {v}": "당신: {v}",
  "Your verdict": "당신의 판정", "Grade from the diff and the criteria. The judge's verdict appears after you decide.": "diff와 기준으로 채점하세요. 심판 판정은 결정 후에 열립니다.", "note (optional)": "메모 (선택)", "Audit recorded for this week": "이번 주 감사 기록됨",
  // quality
  "How much the judge is trusted per action type. Actions graduate to a higher tier when your grades agree with the judge often enough.": "행동 유형별로 심판을 얼마나 신뢰하는지. 당신의 채점이 심판과 충분히 일치하면 행동이 상위 등급으로 승격됩니다.",
  "graduate at {s} labels and {a} agreement · demote below {d}": "레이블 {s}개·일치율 {a}에서 승격 · {d} 미만이면 강등", "Action": "행동", "Tier": "등급", "Verdicts 30d": "판정 30일", "Labels": "레이블", "Agreement": "일치율", "now {t}": "현재 {t}", "fixed": "고정", "Promote to {t}": "{t}로 승격",
  "Promote {a} one tier? company.yaml is committed.": "{a}을(를) 한 등급 승격할까요? company.yaml이 커밋됩니다.", "Promoted {a} → {b}": "{a} → {b} 승격됨",
  // releases
  "Changes to the organization ship as candidates, run on part of the traffic, and are promoted only if they hold up.": "조직 변경은 후보로 배포되어 일부 트래픽에서 돌고, 버텨낼 때만 승격됩니다.",
  "Candidate": "후보", "replay gate running ({n} done)": "리플레이 게이트 실행 중 ({n} 완료)", "replay gate passed": "리플레이 게이트 통과", "replay skipped: no labeled branches": "리플레이 생략: 레이블된 브랜치 없음", "no judge change; canary only": "심판 변경 없음; 카나리만",
  "Canary sessions": "카나리 세션", "{n} ({p}% of production)": "{n} (프로덕션의 {p}%)", "Reject rate": "거절률", "candidate {c} · baseline {b} · allowed +{m} pts": "후보 {c} · 기준 {b} · 허용 +{m}pt", "Decision": "결정", "in {t} (watch {w})": "{t} 후 (감시 {w})", "on the next tick": "다음 틱에",
  "Promote now": "지금 승격", "Withdraw": "철회", "Promote {t} without waiting for the watch?": "감시를 기다리지 않고 {t}을(를) 승격할까요?", "Withdraw {t}? main reverts to {r}.": "{t}을(를) 철회할까요? main이 {r}로 돌아갑니다.", "Released {t}": "{t} 릴리스됨", "Withdrawn": "철회됨",
  "Replay results ({n})": "리플레이 결과 ({n})", "was: {v}": "이전: {v}", "candidate: ": "후보: ",
  "No candidate under watch. Improvement merges create one; {r} is what every session runs on.": "감시 중인 후보 없음. 개선 머지가 후보를 만들며, 모든 세션은 {r}에서 돕니다.", "Tag a release now": "지금 릴리스 태그", "Tag the current organization as a new release?": "현재 조직을 새 릴리스로 태그할까요?",
  "Release": "릴리스", "When": "시각", "Status": "상태", "Changes": "변경", "No releases recorded since this database was created.": "이 데이터베이스 생성 이후 릴리스 기록 없음.",
  "Executed": "실행됨", "No actions executed yet.": "아직 실행된 행동 없음.", "rolled back": "롤백됨", "Roll back": "롤백", "no undo": "되돌리기 없음", "Roll back this action? The action type is demoted one tier and a follow-up ticket opens.": "이 행동을 롤백할까요? 행동 유형이 한 등급 강등되고 후속 티켓이 열립니다.", "Rolled back!": "롤백함",
  // spend
  "Costs are metered in USD at API rates even on a subscription, so budgets and tripwires mean the same everywhere.": "구독이어도 비용은 API 요율의 USD로 계량하므로 예산과 트립와이어의 의미가 어디서나 같습니다.",
  "This month": "이달", "of {m} · {d} in the last 24h · {s} cap per session": "{m} 중 · 최근 24시간 {d} · 세션당 상한 {s}", "Last 14 days": "최근 14일", "Department": "부서", "Share": "몫", "Used": "사용",
  "Session": "세션", "Engine": "엔진", "Turns": "턴", "Cost": "비용", "running": "실행 중", "No sessions in the last 7 days.": "최근 7일 세션 없음.",
  // org
  "Who reports to whom, what each seat runs on, and what it is allowed to do. Change a model here; company.yaml is committed.": "누가 누구에게 보고하고, 각 자리가 어떤 모델로 돌며, 무엇을 할 수 있는지. 여기서 모델을 바꾸면 company.yaml이 커밋됩니다.",
  "You · Operator": "당신 · 운영자", "company.yaml, approvals, weekly grading, interrupts": "company.yaml, 승인, 주간 채점, 인터럽트", "triage, proposals, allocation": "분류, 제안, 배분", "second key: reviews every T2/T3 proposal": "두 번째 열쇠: 모든 T2/T3 제안 검토",
  "Verification": "검증", "judges every ticket · {p}% of share used": "모든 티켓을 판정 · 몫의 {p}% 사용", "Improvement": "개선", "changes the organization through candidate releases": "후보 릴리스로 조직을 바꿈", "{n} live": "{n} 실행 중",
  "{n} open tickets · {p}% of budget": "열린 티켓 {n} · 예산의 {p}%", "Junior workers": "주니어 워커", "one brief each, no company tools": "브리프 하나씩, 회사 도구 없음", "Junior readers": "주니어 리더", "read-only, cheapest model": "읽기 전용, 가장 싼 모델",
  // controls
  "Interrupts stop work in layers. Raising one is immediate; sessions are aborted on the next tick.": "인터럽트는 일을 층위별로 멈춥니다. 올리는 즉시 적용되고, 세션은 다음 틱에 중단됩니다.",
  "Active interrupts": "활성 인터럽트", "No interrupts. Everything that is allowed to run, runs.": "인터럽트 없음. 허용된 모든 것이 돌고 있습니다.", "Resume": "재개", "Resumed {l} on {t}": "{t}의 {l} 재개됨", "Raise an interrupt": "인터럽트 올리기",
  "one agent": "에이전트 하나", "stops that role's sessions; target is a role id such as engineering-senior": "그 역할의 세션을 멈춤; 대상은 engineering-senior 같은 역할 id", "a department": "부서 하나", "stops the department and its dispatch; target is a department or *": "부서와 그 배분을 멈춤; 대상은 부서 또는 *",
  "freezes releases, graduation and improvement": "릴리스·승격·개선을 동결", "the organization": "조직", "one-shot: restores the previous release and withdraws any candidate, then clears itself": "한 번: 이전 릴리스로 되돌리고 후보를 철회한 뒤 스스로 해제", "everything": "전부", "halts the company until you resume": "재개할 때까지 회사를 정지",
  "target: role, department, or *": "대상: 역할, 부서, 또는 *", "reason (written to the control file and the digest)": "사유 (제어 파일과 다이제스트에 기록)", "Raise": "올리기", "target is * for this level": "이 레벨의 대상은 *", "Give a reason; it is written to the control file": "사유를 적으세요; 제어 파일에 기록됩니다",
  "Raise {l} on {t}?": "{t}에 {l}을 올릴까요?", " The organization is restored from the previous release.": " 조직이 이전 릴리스로 복원됩니다.", " Everything stops.": " 모든 것이 멈춥니다.", "{l} raised on {t}": "{t}에 {l} 올림",
  // settings
  "What the company is for and how much it may spend. Every save is committed to company.yaml or docs/holdco/strategy.md.": "회사가 무엇을 위한 것이고 얼마나 쓸 수 있는지. 저장할 때마다 company.yaml 또는 전략 문서에 커밋됩니다.",
  "Strategy": "전략", "The CEO reads this at every triage. Objectives, constraints, what not to do.": "CEO가 분류할 때마다 읽습니다. 목표, 제약, 하지 말 것.", "Save strategy": "전략 저장", "Strategy saved and committed": "전략 저장·커밋됨",
  "Budget & limits": "예산·한도", "Monthly budget (USD)": "월 예산 (USD)", "Per-session cap (USD)": "세션당 상한 (USD)", "Max concurrent sessions": "최대 동시 세션", "Max attempts per ticket": "티켓당 최대 시도", "Inbox timeout": "인박스 시한", "e.g. 48h": "예: 48h", "Routine digest at": "정기 다이제스트 시각", "Audit sample per week": "주간 감사 샘플", "Save limits": "한도 저장", "Limits saved and committed": "한도 저장·커밋됨",
  "Dashboard": "대시보드", "Shown in this browser only.": "이 브라우저에만 적용됩니다.",
  // drawer
  "Overview": "개요", "Live ●": "라이브 ●", "Log": "로그", "Why": "이유", "{c} across {n} sessions": "세션 {n}에 걸쳐 {c}", "Attempts": "시도", "Decision needed": "결정 필요", "your decision, in one line (the senior reads it)": "한 줄 결정 (시니어가 읽습니다)", "Unblock with this decision": "이 결정으로 풀기", "Decline the ticket": "티켓 기각", "Write the decision first": "결정을 먼저 적으세요", "Unblocked": "풀림", "Decline {id}?": "{id}를 기각할까요?", "Declined!": "기각함",
  "{o}/4 · {c} confidence": "{o}/4 · 신뢰도 {c}", "Timeline": "타임라인", "Sessions": "세션", "Your notes": "당신의 메모", "Notes are binding for the next session on this ticket (senior and judge). A running session does not see them.": "메모는 이 티켓의 다음 세션(시니어·심판)에 구속력이 있습니다. 실행 중인 세션은 보지 못합니다.", "a note for the next session, e.g. use the existing fee helper": "다음 세션에 줄 메모, 예: 기존 fee 헬퍼를 쓸 것", "Add note": "메모 추가", "Noted": "메모됨", "No branch yet.": "아직 브랜치 없음.", "Diff vs {b}": "{b} 대비 diff", "{n} turns": "{n}턴",
  // live
  "No session has run on this ticket yet.": "이 티켓에서 돈 세션이 아직 없습니다.", "live": "라이브", "running · {t}": "실행 중 · {t}", "ended": "종료", "{n} events": "이벤트 {n}", "follow": "따라가기", "waiting for the first event…": "첫 이벤트 대기 중…", "no journal for this session (it ran on an older kernel)": "이 세션의 저널 없음 (이전 커널에서 돌았음)", "edit {p}": "편집 {p}",
  // files / diff
  "No files on the branch yet.": "브랜치에 아직 파일 없음.", "Pick a file": "파일을 고르세요", "Loading…": "불러오는 중…", "binary file": "바이너리 파일", "truncated": "잘림", "{n} files changed": "파일 {n}개 변경", "No changes.": "변경 없음.", "diff truncated": "diff 잘림",
  // new ticket
  "Edit {id}": "{id} 편집", "Save changes": "변경 저장", "Open ticket": "티켓 열기", "Opened by you; starts triaged, skipping the CEO.": "당신이 엽니다; CEO를 건너뛰고 분류됨 상태로 시작.", "Feature": "기능", "Bug fix": "버그 수정", "Research": "리서치", "Content": "콘텐츠", "Branch only": "브랜치만",
  "Title": "제목", "What should be true when this is done, in one line": "끝났을 때 참이어야 하는 것, 한 줄로", "Project": "프로젝트", "(none)": "(없음)", "Action (what the result is)": "행동 (결과가 무엇인지)", "let the senior choose": "시니어가 고르게", "Priority": "우선순위", "1 — first": "1 — 먼저", "3 — normal": "3 — 보통", "5 — whenever": "5 — 언제든",
  "The outcome, not the steps. The senior plans the steps.": "단계가 아니라 결과. 단계는 시니어가 계획합니다.", "Which objective this serves (the CEO and the judge read it)": "어느 목표를 위한 것인지 (CEO와 심판이 읽습니다)", "Done criteria, one per line": "완료 기준, 한 줄에 하나", "A title is needed": "제목이 필요합니다", "Saved": "저장됨", "{id} opened — the senior picks it up on the next tick": "{id} 열림 — 다음 틱에 시니어가 가져갑니다",
  "You graded it {v} on {t}": "{t}에 {v}로 채점함", "Verdict withheld until you grade this ticket in the audit.": "감사에서 이 티켓을 채점할 때까지 판정은 가려집니다.", "Notes to the next session": "다음 세션에 줄 메모", "Tell the senior or the judge something; the next session on this ticket reads it": "시니어나 심판에게 할 말; 이 티켓의 다음 세션이 읽습니다", "Note saved; it reaches {r}": "메모 저장됨; {r}에 전달", "Loading…!": "불러오는 중…",
  "No files changed{b}.": "변경된 파일 없음{b}.", " vs {b}": " ({b} 대비)", "Binary file.": "바이너리 파일.", "Truncated at 300 KB.": "300 KB에서 잘림.", "No changes against {b}.": "{b} 대비 변경 없음.", "Diff truncated at 400 KB; open the branch in your editor for the rest.": "diff가 400 KB에서 잘림; 나머지는 에디터에서 브랜치를 여세요.",
  "The next session re-reads goal and criteria.": "다음 세션이 목표와 기준을 다시 읽습니다.",
  // your move
  "Your move": "당신 차례", "Nothing needed from you": "당신이 할 일 없음", "{n} sessions are working; the company approves its own work within the rules": "세션 {n}개가 일하는 중; 회사는 규칙 안에서 스스로 결재합니다", "The company is between steps; see what each ticket waits on below": "회사가 단계 사이에 있습니다; 아래에서 각 티켓이 무엇을 기다리는지 보세요",
  "The supervisor is not running": "슈퍼바이저가 꺼져 있음", "bunx holdco service install — nothing happens until it runs": "bunx holdco service install — 돌기 전엔 아무 일도 안 일어남", "Everything is halted (L5)": "전부 정지됨 (L5)", "Resume it in Controls when you are ready": "준비되면 제어에서 재개",
  "Decide: {t}": "결정: {t}", "{n} decisions waiting; first: {t}": "결정 {n}건 대기; 첫 번째: {t}", "Approve or reject; a and r work from the inbox": "승인 또는 거절; 인박스에서 a·r 키", "{n} tickets are stuck": "티켓 {n}개가 막힘", "{n} interrupts active": "인터럽트 {n}개 활성", "Resume them when the reason is gone": "이유가 사라지면 재개", "Weekly audit due: grade {n} tickets": "주간 감사 기한: {n}건 채점", "Ten minutes; it keeps the judge calibrated": "10분; 심판 보정용", "judge agreement": "심판 일치율",
  // waiting on
  "Waiting on": "대기 중", "nothing runs until one of these moves": "이 중 하나가 움직여야 세션이 돕니다",
  "w.session": "{d} 세션 실행 중", "w.ceo_triage": "CEO 분류", "w.ceo_proposal": "CEO 제안서 (T2/T3 승인 경로)", "w.coo_review": "COO 검토 (다음 틱)", "w.operator": "당신의 결정 (인박스)", "w.senior_slot": "시니어 세션 (다음 틱, 빈 슬롯)", "w.verification_slot": "검증 세션 (다음 틱)", "w.lease": "리스 (만료되면 회수)", "w.kernel": "커널 (다음 틱)",
  "in {t}": "{t} 후", "now": "지금", "CEO runs in {t}": "CEO {t} 후 실행", "CEO is due now": "CEO 곧 실행", "it opens the next tickets from the strategy": "전략에서 다음 티켓을 엽니다",
  // misc
  "Dashboard unreachable": "대시보드에 연결할 수 없음", "Could not load": "불러올 수 없음", "Loading {id}…": "{id} 불러오는 중…",
}
