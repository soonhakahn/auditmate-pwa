import { useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import Tesseract from 'tesseract.js'
import './App.css'

function extractNumbers(text) {
  const matches = text.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g) || []
  return matches.map((raw) => ({ raw, value: Number(raw.replace(/,/g, '')) })).filter((x) => !Number.isNaN(x.value))
}

function normalizeLine(line) {
  return line
    .replace(/\bteh\b/gi, 'the')
    .replace(/\brecieve\b/gi, 'receive')
    .replace(/\bseperate\b/gi, 'separate')
    .replace(/\s{2,}/g, ' ')
    .replace(/ ,/g, ',')
    .trim()
}

function translateLineToEnglish(line) {
  return normalizeLine(line)
    .replace(/^검토 결과:/, 'Review result:')
    .replace(/합계/g, 'total')
    .replace(/총계/g, 'grand total')
    .replace(/부가세/g, 'VAT')
    .replace(/추정치/g, 'estimated figure')
    .replace(/확정치/g, 'final figure')
    .replace(/전일\/당일/g, 'yesterday/today')
    .replace(/원본 표 전체를 넣어주실 수 있나요\?/g, 'Could you provide the full original table?')
}

function rewriteText(text, language) {
  const lines = text.split(/\n+/).map((line) => normalizeLine(line)).filter(Boolean)
  return lines
    .map((line) => {
      if (/^# Sheet:/i.test(line)) return line
      if (language === 'en') {
        const translated = translateLineToEnglish(line)
        return translated.endsWith('.') || translated.endsWith('!') || translated.endsWith('?') ? translated : `${translated}.`
      }
      if (/합계|총계|subtotal/i.test(line)) return `검토 결과: ${line}`
      if (/^[•\-*]/.test(line)) return line
      return line.endsWith('.') || line.endsWith('!') || line.endsWith('?') ? line : `${line}.`
    })
    .join('\n')
}

function analyzeText(text, language) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  const questions = []
  const issues = []
  const grammar = []

  lines.forEach((line, idx) => {
    if (/\bteh\b|\brecieve\b|\bseperate\b/i.test(line)) {
      grammar.push(language === 'en' ? `Line ${idx + 1}: Possible spelling issue → "${line}"` : `Line ${idx + 1}: 흔한 철자 오류 가능성 → "${line}"`)
    }
    if (/\s{2,}/.test(line)) {
      grammar.push(language === 'en' ? `Line ${idx + 1}: Extra double spaces found.` : `Line ${idx + 1}: 불필요한 이중 공백이 있습니다.`)
    }
    if (!/[.!?]$/.test(line) && /[A-Za-z가-힣]/.test(line) && !/^# Sheet:/i.test(line)) {
      grammar.push(language === 'en' ? `Line ${idx + 1}: Sentence ending punctuation can be improved → "${line}"` : `Line ${idx + 1}: 문장 종결 부호 보강 가능 → "${line}"`)
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
        issues.push(language === 'en' ? `Subtotal check: ${nums[i].raw} + ${nums[i + 1].raw} = ${nums[i + 2].raw} ✅` : `부분합 체크: ${nums[i].raw} + ${nums[i + 1].raw} = ${nums[i + 2].raw} ✅`)
      }
    }
  }

  if (/subtotal|합계|총계/i.test(text) && nums.length < 2) {
    questions.push(language === 'en' ? 'A total/subtotal is visible, but there are not enough detail numbers. Could you provide the full original table?' : '합계/총계가 보이는데 세부 숫자가 충분하지 않습니다. 원본 표 전체를 넣어주실 수 있나요?')
  }
  if (/vat|부가세/i.test(text) === false && /합계|총계|subtotal/i.test(text)) {
    questions.push(language === 'en' ? 'Please confirm whether the total includes VAT.' : '합계가 VAT 포함인지 제외인지 확인이 필요합니다.')
  }
  if (/예상|추정|forecast/i.test(text)) {
    questions.push(language === 'en' ? 'Please confirm whether this is an estimate or a final figure.' : '추정치인지 확정치인지 구분해 주실 수 있나요?')
  }
  if (!lines.length) {
    questions.push(language === 'en' ? 'The input is empty. Please paste text or upload a file.' : '입력 텍스트가 비어 있습니다. 붙여넣기 또는 파일 업로드가 필요합니다.')
  }

  return { lines, nums, issues, grammar, questions, finalVersion: rewriteText(text, language) }
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
  const [copied, setCopied] = useState(false)
  const [language, setLanguage] = useState('en')

  const mergedText = useMemo(() => [text, attachmentText].filter(Boolean).join('\n\n'), [text, attachmentText])
  const result = useMemo(() => analyzeText(mergedText, language), [mergedText, language])

  const handleIncomingFile = async (file) => {
    if (!file) return
    setLoading(true)
    setSourceName(file.name || 'clipboard-image')
    try {
      if (/xlsx|xls|csv/.test((file.name || '').toLowerCase())) {
        setAttachmentText(await readExcel(file))
      } else if (file.type.startsWith('image/') || /png|jpg|jpeg|webp|gif|heic/i.test((file.name || '').toLowerCase())) {
        setAttachmentText(await readImage(file))
      } else if (/txt|md/i.test((file.name || '').toLowerCase())) {
        setAttachmentText(await file.text())
      } else {
        setAttachmentText(language === 'en' ? `Unsupported file type: ${file.name || file.type}` : `지원하지 않는 파일 형식입니다: ${file.name || file.type}`)
      }
    } finally {
      setLoading(false)
    }
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    await handleIncomingFile(file)
  }

  const onPaste = async (e) => {
    const items = Array.from(e.clipboardData?.items || [])
    const imageItem = items.find((item) => item.type?.startsWith('image/'))
    if (imageItem) {
      e.preventDefault()
      const file = imageItem.getAsFile()
      await handleIncomingFile(file)
    }
  }

  const copyFinal = async () => {
    await navigator.clipboard.writeText(result.finalVersion || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="app-shell" onPaste={onPaste}>
      <header className="hero">
        <div>
          <p className="eyebrow">iPhone 홈화면 설치형 검수 앱</p>
          <h1>AuditMate</h1>
          <p className="subtitle">붙여넣기/엑셀/캡처를 넣으면 숫자 합계, 부분합, 문법, 추가 확인 질문, 그리고 최종 교정본까지 한 번에 점검합니다.</p>
        </div>
      </header>

      <section className="card">
        <div className="row">
          <h2>작업 언어</h2>
          <div className="lang-switch">
            <button className={language === 'en' ? 'lang-btn active' : 'lang-btn'} onClick={() => setLanguage('en')}>영어로</button>
            <button className={language === 'ko' ? 'lang-btn active' : 'lang-btn'} onClick={() => setLanguage('ko')}>한글로</button>
          </div>
        </div>
        <p className="muted">최종 결과물은 선택한 언어로 표시됩니다.</p>
      </section>

      <section className="card">
        <h2>{language === 'en' ? 'Input' : '입력'}</h2>
        <label className="label">{language === 'en' ? 'Paste text / commentary' : '텍스트/Commentary 붙여넣기'}</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={language === 'en' ? 'Paste commentary or table text here' : '여기에 commentary 또는 표 텍스트를 붙여넣으세요'}
          rows={10}
        />
        <label className="label">{language === 'en' ? 'Paste image / screenshot' : '그림/캡처 붙여넣기'}</label>
        <div className="paste-zone">
          {language === 'en' ? 'Copy an image and paste it here. (Ctrl+V / ⌘V)' : '캡처 이미지를 복사한 뒤 이 화면에서 붙여넣기 하세요. (Ctrl+V / ⌘V)'}
        </div>
        <label className="label">{language === 'en' ? 'File upload (Excel / image / text)' : '파일 업로드 (엑셀 / 이미지 / 텍스트)'}</label>
        <input type="file" onChange={onFile} />
        {loading && <p className="muted">{language === 'en' ? 'Analyzing file…' : '파일 분석 중…'}</p>}
        {sourceName && <p className="muted">{language === 'en' ? 'Attachment' : '첨부'}: {sourceName}</p>}
      </section>

      <section className="grid">
        <article className="card">
          <h2>{language === 'en' ? 'Number Check' : '숫자 검증'}</h2>
          <p className="muted">{language === 'en' ? `Extracted ${result.nums.length} numbers` : `추출 숫자 ${result.nums.length}개`}</p>
          <ul>
            {result.issues.length ? result.issues.map((item, i) => <li key={i}>{item}</li>) : <li>{language === 'en' ? 'No automatic subtotal pattern found yet.' : '자동 부분합 일치 패턴을 아직 찾지 못했습니다.'}</li>}
          </ul>
        </article>

        <article className="card">
          <h2>{language === 'en' ? 'Grammar / Wording' : '문법/표현 체크'}</h2>
          <ul>
            {result.grammar.length ? result.grammar.map((item, i) => <li key={i}>{item}</li>) : <li>{language === 'en' ? 'No obvious basic grammar/notation issues found.' : '눈에 띄는 기본 문법/표기 이슈가 없습니다.'}</li>}
          </ul>
        </article>

        <article className="card">
          <h2>{language === 'en' ? 'Follow-up Questions' : '추가 질문'}</h2>
          <ul>
            {result.questions.length ? result.questions.map((item, i) => <li key={i}>{item}</li>) : <li>{language === 'en' ? 'No additional questions.' : '추가 질문이 없습니다.'}</li>}
          </ul>
        </article>
      </section>

      <section className="card">
        <div className="row">
          <h2>{language === 'en' ? 'Final Version' : '최종 교정본 (Final Version)'}</h2>
          <button className="copy-btn" onClick={copyFinal}>{copied ? (language === 'en' ? 'Copied' : '복사됨') : (language === 'en' ? 'Copy' : '복사')}</button>
        </div>
        <pre>{result.finalVersion || (language === 'en' ? 'No input yet.' : '아직 입력이 없습니다.')}</pre>
      </section>

      <section className="card">
        <h2>{language === 'en' ? 'Extracted Source' : '추출 원문'}</h2>
        <pre>{mergedText || (language === 'en' ? 'No input yet.' : '아직 입력이 없습니다.')}</pre>
      </section>
    </div>
  )
}
