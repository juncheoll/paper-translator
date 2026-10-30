const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

export function extractGraphicRegions(operatorList, viewport, ops) {
  if (!operatorList || !ops) return [];
  let matrix = viewport.transform || [1, 0, 0, -1, 0, viewport.height];
  const stack = [], regions = [], containers = [];
  let pathBounds = [];
  const painting = new Set(["stroke", "closeStroke", "fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]
    .map((name) => ops[name]).filter(Number.isInteger));
  const add = (bounds, padding = 0, container = false) => {
    if (!bounds || bounds.length !== 4 || !Array.from(bounds).every(Number.isFinite)) return;
    const points = [bounds[0], bounds[2]].flatMap((x) => [bounds[1], bounds[3]].map((y) =>
      [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]));
    const x = Math.min(...points.map(([x]) => x)), y = Math.min(...points.map(([, y]) => y));
    const width = Math.max(...points.map(([x]) => x)) - x, height = Math.max(...points.map(([, y]) => y)) - y;
    if (width < 35 || height < 24 || width * height > viewport.width * viewport.height * 0.65) return;
    const region = { x: x - padding, y: y - padding, width: width + padding * 2, height: height + padding * 2,
      ...(container ? { painted: false } : {}) };
    regions.push(region);
    return region;
  };
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const op = operatorList.fnArray[i], args = operatorList.argsArray[i];
    if (op === ops.save) stack.push(matrix);
    else if (op === ops.restore) matrix = stack.pop() || matrix;
    else if (op === ops.paintFormXObjectEnd || op === ops.endGroup) {
      const container = containers.pop();
      if (container?.region) container.region.painted = container.graphics >= 3;
      matrix = stack.pop() || matrix;
    }
    else if (op === ops.transform) matrix = multiply(matrix, args);
    else if (op === ops.paintFormXObjectBegin || op === ops.beginGroup) {
      stack.push(matrix);
      const original = matrix;
      const transform = op === ops.beginGroup ? args[0]?.matrix : args[0];
      if (transform) matrix = multiply(matrix, transform);
      containers.push({ region: add(op === ops.beginGroup ? args[0]?.bbox : args[1], 0, true), graphics: 0 });
      if (op === ops.beginGroup) matrix = original;
    } else if (op === ops.constructPath) pathBounds.push(args[2]);
    else if (op === ops.endPath) pathBounds = [];
    else if (painting.has(op) || op === ops.paintImageXObject || op === ops.paintInlineImageXObject) {
      const bounds = painting.has(op) ? pathBounds : [[0, 0, 1, 1]];
      for (const box of bounds) {
        const region = add(box, painting.has(op) ? 12 : 0);
        if (region) for (const container of containers) container.graphics++;
      }
      if (painting.has(op)) pathBounds = [];
    }
  }
  return regions.filter((region) => region.painted !== false).map(({ painted, ...region }) => region);
}

export function figureRegionsNearCaptions(items, regions) {
  const captions = items.filter((item) => /^(?:fig(?:ure)?\.?|table)\s*\d+[.:]/i.test(item.text.trim()));
  const blocked = regions.map((region) => captions.some(({ box }) =>
    Math.min(region.x + region.width, box.x + box.width) - Math.max(region.x, box.x) >= Math.min(region.width, box.width) * 0.5 &&
    box.y > region.y && box.y + box.height < region.y + region.height));
  const associated = regions.map((region, i) => {
    if (blocked[i]) return null;
    let nearest = null;
    for (const caption of captions) {
      const box = caption.box;
      const overlap = Math.min(region.x + region.width, box.x + box.width) - Math.max(region.x, box.x);
      if (overlap < Math.min(region.width, box.width) * 0.5) continue;
      const distance = Math.max(box.y - region.y - region.height, region.y - box.y - box.height, 0);
      if (distance > 55 || box.y > region.y && box.y + box.height < region.y + region.height) continue;
      if (!nearest || distance < nearest.distance) nearest = { caption, distance };
    }
    return nearest?.caption || null;
  });
  // Follow actual panel overlaps, retaining each rectangle so text in gaps cannot be swallowed by their bounding box.
  const queue = associated.flatMap((caption, i) => caption && /^fig/i.test(caption.text.trim()) ? [i] : []);
  for (let at = 0; at < queue.length; at++) {
    const i = queue[at], region = regions[i];
    for (let j = 0; j < regions.length; j++) {
      const other = regions[j];
      if (associated[j] || blocked[j] || region.x >= other.x + other.width || other.x >= region.x + region.width ||
          region.y >= other.y + other.height || other.y >= region.y + region.height) continue;
      associated[j] = associated[i]; queue.push(j);
    }
  }
  return regions.flatMap((region, i) => {
    if (!associated[i] || !/^fig/i.test(associated[i].text.trim())) return [];
    const caption = associated[i].box;
    const nearby = Math.max(caption.y - region.y - region.height, region.y - caption.y - caption.height, 0) <= 55;
    const top = nearby && caption.y < region.y ? caption.y + caption.height + 1 : region.y;
    const bottom = nearby && caption.y >= region.y ? caption.y - 1 : region.y + region.height;
    return bottom > top ? [{ ...region, y: top, height: bottom - top }] : [];
  });
}
