import { translateSentencePart } from "../src/pdf/sentence_translation";

const failure = (code) => Object.assign(new Error(code), { code });

test("a clipped answer is discarded before one visible recovery without references", async () => {
  const translate = jest.fn().mockRejectedValueOnce(failure("OUTPUT_LIMIT"))
    .mockResolvedValueOnce({ targetText: "완전한 번역", diagnostics: { finishReason: "stop" } });
  const result = await translateSentencePart("Source", "ko", "Reference", translate);
  expect(translate.mock.calls.map(([, , reference]) => reference)).toEqual(["Reference", ""]);
  expect(result).toMatchObject({ targetText: "완전한 번역", contextReduced: true });
});

test("normal context translation uses one request and an empty response can recover once", async () => {
  const normal = jest.fn().mockResolvedValue({ targetText: "문맥 번역" });
  expect(await translateSentencePart("Source", "ko", "Reference", normal)).toMatchObject({ contextReduced: false });
  expect(normal).toHaveBeenCalledTimes(1);
  const empty = jest.fn().mockResolvedValueOnce({ targetText: " " }).mockResolvedValueOnce({ targetText: "재시도 번역" });
  expect(await translateSentencePart("Source", "ko", "Reference", empty)).toMatchObject({ contextReduced: true });
  expect(empty).toHaveBeenCalledTimes(2);
});

test("persistent output limits and unrelated server errors remain retryable errors without loops", async () => {
  const clipped = jest.fn().mockRejectedValue(failure("OUTPUT_LIMIT"));
  await expect(translateSentencePart("Source", "ko", "Reference", clipped)).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  expect(clipped).toHaveBeenCalledTimes(2);
  const offline = jest.fn().mockRejectedValue(failure("CONNECTION_ERROR"));
  await expect(translateSentencePart("Source", "ko", "Reference", offline)).rejects.toMatchObject({ code: "CONNECTION_ERROR" });
  expect(offline).toHaveBeenCalledTimes(1);
  const noContext = jest.fn().mockRejectedValue(failure("OUTPUT_LIMIT"));
  await expect(translateSentencePart("Source", "ko", "", noContext)).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  expect(noContext).toHaveBeenCalledTimes(1);
});

test("stopping cancels the in-flight request and prevents a recovery request", async () => {
  const aborter = new AbortController();
  const translate = jest.fn(async (_, __, ___, { signal }) => {
    expect(signal).toBe(aborter.signal);
    aborter.abort();
    throw failure("OUTPUT_LIMIT");
  });
  await expect(translateSentencePart("Source", "ko", "Reference", translate, { signal: aborter.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(translate).toHaveBeenCalledTimes(1);
});

test("retry sampling and cancellation options also reach a context-free recovery", async () => {
  const translate = jest.fn().mockRejectedValueOnce(failure("OUTPUT_LIMIT")).mockResolvedValue({ targetText: "완전한 번역" });
  const options = { signal: new AbortController().signal, temperature: 0.4, seed: 123 };
  await translateSentencePart("Source", "ko", "Reference", translate, options);
  expect(translate).toHaveBeenNthCalledWith(1, "Source", "ko", "Reference", options);
  expect(translate).toHaveBeenNthCalledWith(2, "Source", "ko", "", options);
});

test('lost inline math can recover once without background and retains preservation options',async()=>{
 const translate=jest.fn().mockRejectedValueOnce(failure('MATH_PLACEHOLDER')).mockResolvedValue({targetText:'값 [M1]'});
 const result=await translateSentencePart('Value [M1]','ko','Context',translate,{preserveMath:true});
 expect(result.targetText).toBe('값 [M1]');expect(translate.mock.calls[1][2]).toBe('');expect(translate.mock.calls[1][3].preserveMath).toBe(true);
});
