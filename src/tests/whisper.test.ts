import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhisperJson } from '../server/asr/whisperCpp.js';
import { SR } from '../shared/types.js';

// whisper-cli -ojf の出力形式(examples/cli/cli.cpp の output_json に準拠)
const SAMPLE = `{
	"transcription": [
		{
			"timestamps": { "from": "00:00:00,000", "to": "00:00:02,500" },
			"offsets": { "from": 0, "to": 2500 },
			"text": "今日は節約術を紹介します。",
			"tokens": [
				{ "text": "[_BEG_]", "timestamps": { "from": "00:00:00,000", "to": "00:00:00,000" }, "offsets": { "from": 0, "to": 0 }, "id": 50364, "p": 0.9, "t_dtw": -1 },
				{ "text": "今日は", "timestamps": { "from": "00:00:00,320", "to": "00:00:00,800" }, "offsets": { "from": 320, "to": 800 }, "id": 1, "p": 0.95, "t_dtw": 30 },
				{ "text": "節約", "offsets": { "from": 800, "to": 1300 }, "id": 2, "p": 0.8, "t_dtw": 78 },
				{ "text": "術を", "offsets": { "from": 1300, "to": 1700 }, "id": 3, "p": 0.7, "t_dtw": 131 },
				{ "text": "紹介します。", "offsets": { "from": 1700, "to": 2400 }, "id": 4, "p": 0.9, "t_dtw": 170 },
				{ "text": "[_TT_125]", "offsets": { "from": 2500, "to": 2500 }, "id": 50489, "p": 0.5, "t_dtw": -1 }
			]
		},
		{
			"offsets": { "from": 3000, "to": 4000 },
			"text": "以上\u0001です",
			"tokens": []
		}
	]
}`;

test('whisper.cpp の JSON からトークン時刻を取り出し、特殊トークンを除く', () => {
  const r = parseWhisperJson(SAMPLE, false);
  const texts = r.tokens.map((t) => t.text);
  assert.deepEqual(texts.slice(0, 4), ['今日は', '節約', '術を', '紹介します。']);
  const t0 = r.tokens[0]!;
  assert.equal(t0.start, Math.round(0.32 * SR));
  assert.equal(t0.end, Math.round(0.8 * SR));
  assert.equal(t0.timing, 'token');
  // トークンがないセグメントは「区間単位の時刻」として明示する
  const last = r.tokens[r.tokens.length - 1]!;
  assert.equal(last.timing, 'segment');
  assert.equal(last.text, '以上です');
  assert.ok(r.notes.some((n) => n.includes('区間単位')));
});

test('DTW 時刻を使う場合は t_dtw(10ms単位)から開始を取り、次の語の開始を終了にする', () => {
  const r = parseWhisperJson(SAMPLE, true);
  const [a, b] = r.tokens;
  assert.equal(a!.timing, 'dtw');
  assert.equal(a!.start, Math.round(0.3 * SR));
  assert.equal(a!.end, Math.round(0.78 * SR));
  assert.equal(b!.start, Math.round(0.78 * SR));
});
