import { useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import Tesseract from 'tesseract.js'
import './App.css'

function extractNumbers(text) {
  const matches = text.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g) || []
  return matches.map((raw) => ({ raw, value: Number(raw.replace(/,/g, '')) })).filter((x) => !Number.isNaN(x.value))
}

function analyzeText(text) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  const questions = []
  const issues = []
  const grammar = []

  lines.forEach((line, idx) => {
    if (/\bteh\b|\brecieve\b|\bseperate\b/i.test(line)) {
      grammar.push(`Line ${idx + 1}: 흔한 철자 오류 가능성 → "${line}"`)
    }
    if (/\s{2,}/.test(line)) {
      grammar.push(`Line ${idx + 1}: 불필요한 이중 공백이 있습니다.`)
    }
  })

  const nums = extractNumbers(text)
  if (nums.length >= 3) {
    for (let i = 0; i < nums.length - 2; i += 1) {
      const a = nums[i]?.value
      const b = nums[i + 1]?.value
      const c = nums[i + 2]?.value
      const epsilon = 0.001
      if (Math.abs((a + b) - c) < epsilon) {
        issues.push(`부분합 체크: ${nums[i].raw} + ${nums[i + 1].raw} = ${nums[i + 2].raw} ✅`)
      }
    }
  }

  if (/subtotal|합계|총계/i.test(text) && nums.length < 2) {
    questions.push('합계/총계가 보이는데 세부 숫자가 충분하지 않습니다. 원본 표 전체를 넣어주실 수 있나요?')
  }
  if (/vat|부가세/i.test(text) === false && /합계|총계|subtotal/i.test(text)) {
    questions.push('합계가 VAT 포함인지 제외인지 확인이 필요합니다.')
  }
  if (/예상|추정|forecast/i.test(text)) {
    questions.push('추정치인지 확정치인지 구분해 주실 수 있나요?')
  }
  if (!lines.length) {
    questions.push('입력 텍스트가 비어 있습니다. 붙여넣기 또는 파일 업로드가 필요합니다.')
  }

  return { lines, nums, issues, grammar, questions }
}

async function readExcel(file) {
  const data = await file.arrayBuffer()
  const workbook = XLSX.read(data)
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name]
    return `# Sheet: ${name}\n` + XLSX.utils.sheet_to_csv(sheet)
  }).join('\n\n')
}

async function readImage(file) {
  const { data } = await Tesseract.recognize(file, 'eng+kor')
  return data.text || ''
}

export default function App() {
  const [text, setText] = useState('')
  const [attachmentText, setAttachmentText] = useState('')
  const [loading, setLoading] = useState(false)
  const [sourceName, setSourceName] = useState('')

  const mergedText = useMemo(() => [text, attachmentText].filter(Boolean).join('\n\n'), [text, attachmentText])
  const result = useMemo(() => analyzeText(mergedText), [mergedText])

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLoading(true)
    setSourceName(file.name)
    try {
      if (/xlsx|xls|csv/.test(file.name.toLowerCase())) {
        setAttachmentText(await readExcel(file))
      } else if (/png|jpg|jpeg|webp|gif|heic/i.test(file.name.toLowerCase())) {
        setAttachmentText(await readImage(file))
      } else if (/txt|md/i.test(file.name.toLowerCase())) {
        setAttachmentText(await file.text())
      } else {
        setAttachmentText(`지원하지 않는 파일 형식입니다: ${file.name}`)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">iPhone 홈화면 설치형 검수 앱</p>
          <h1>AuditMate</h1>
          <p className="subtitle">붙여넣기/엑셀/캡처를 넣으면 숫자 합계, 부분합, 문법, 추가 확인 질문을 한 번에 점검합니다.</p>
        </div>
      </header>

      <section className="card">
        <h2>입력</h2>
        <label className="label">텍스트/Commentary 붙여넣기</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="여기에 commentary 또는 표 텍스트를 붙여넣으세요"
          rows={10}
        />
        <label className="label">파일 업로드 (엑셀 / 이미지 / 텍스트)</label>
        <input type="file" onChange={onFile} />
        {loading && <p className="muted">파일 분석 중…</p>}
        {sourceName && <p className="muted">첨부: {sourceName}</p>}
      </section>

      <section className="grid">
        <article className="card">
          <h2>숫자 검증</h2>
          <p className="muted">추출 숫자 {result.nums.length}개</p>
          <ul>
            {result.issues.length ? result.issues.map((item, i) => <li key={i}>{item}</li>) : <li>자동 부분합 일치 패턴을 아직 찾지 못했습니다.</li>}
          </ul>
        </article>

        <article className="card">
          <h2>문법/표현 체크</h2>
          <ul>
            {result.grammar.length ? result.grammar.map((item, i) => <li key={i}>{item}</li>) : <li>눈에 띄는 기본 문법/표기 이슈가 없습니다.</li>}
          </ul>
        </article>

        <article className="card">
          <h2>추가 질문</h2>
          <ul>
            {result.questions.length ? result.questions.map((item, i) => <li key={i}>{item}</li>) : <li>추가 질문이 없습니다.</li>}
          </ul>
        </article>
      </section>

      <section className="card">
        <h2>추출 원문</h2>
        <pre>{mergedText || '아직 입력이 없습니다.'}</pre>
      </section>
    </div>
  )
}
