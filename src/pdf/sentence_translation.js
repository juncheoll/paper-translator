function stopped(signal) {
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
}

// A clipped answer is discarded; one source-only attempt can recover a model stuck on its references.
export async function translateSentencePart(text, target, context, translate, options = {}) {
  const { signal } = options;
  const request = async (reference) => {
    stopped(signal);
    const response = await translate(text, target, reference, options);
    stopped(signal);
    if (!response?.targetText?.trim() || response.isBroken) {
      const error = new Error("The model returned no complete translation");
      error.code = "EMPTY_OUTPUT";
      throw error;
    }
    return response;
  };
  try {
    return { ...await request(context), contextReduced: false };
  } catch (error) {
    stopped(signal);
    if (!context || !["OUTPUT_LIMIT", "EMPTY_OUTPUT", "MATH_PLACEHOLDER"].includes(error.code)) throw error;
    return { ...await request(""), contextReduced: true };
  }
}
