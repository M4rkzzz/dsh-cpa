import {isMainThread, parentPort} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {SaxesParser} from 'saxes';
import {initWasm, Resvg} from '@resvg/resvg-wasm';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const MAX_INPUT = 256 * 1024, MAX_OUTPUT = 2 * 1024 * 1024, SIZE = 1024;
const MAX_NODES = 2048, MAX_DEPTH = 32, MAX_SEGMENTS = 8192, MAX_NUMBERS = 32768;
const OWN_ERROR = Symbol('png-error');
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const NUMBER_TOKEN = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline']);
const GRADIENTS = new Set(['linearGradient', 'radialGradient']);
const ELEMENTS = new Set(['svg', 'g', 'defs', ...SHAPES, ...GRADIENTS, 'stop', 'clipPath', 'style', 'title', 'desc']);
const LENGTHS = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'width', 'height']);
const ATTRIBUTES = {
  svg: new Set(['width', 'height', 'viewBox', 'preserveAspectRatio', 'version']),
  g: new Set(), defs: new Set(),
  path: new Set(['d', 'pathLength']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry']),
  circle: new Set(['cx', 'cy', 'r']), ellipse: new Set(['cx', 'cy', 'rx', 'ry']),
  line: new Set(['x1', 'y1', 'x2', 'y2']),
  polygon: new Set(['points']), polyline: new Set(['points']),
  linearGradient: new Set(['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'href']),
  radialGradient: new Set(['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'href']),
  stop: new Set(['offset']), clipPath: new Set(['clipPathUnits']),
  style: new Set(['type']), title: new Set(), desc: new Set(),
};
const ENUMS = {
  'stroke-linecap': ['butt', 'round', 'square'], 'stroke-linejoin': ['miter', 'round', 'bevel'],
  'fill-rule': ['nonzero', 'evenodd'], 'clip-rule': ['nonzero', 'evenodd'],
  'vector-effect': ['none', 'non-scaling-stroke'], display: ['none', 'inline'],
  visibility: ['visible', 'hidden', 'collapse'], 'shape-rendering': ['auto', 'optimizeSpeed', 'crispEdges', 'geometricPrecision'],
};
const PROPERTIES = new Set(['fill', 'stroke', 'color', 'stop-color', 'opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity',
  'stroke-width', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'clip-path', ...Object.keys(ENUMS)]);
const COLORS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor').split(' '));
const IDENTITY = [1, 0, 0, 1, 0, 0];

function fail(code = 'png-unsafe-svg') {throw Object.assign(new Error(code), {code, [OWN_ERROR]: true});}
function number(value, min = -1000000, max = 1000000) {
  if (!NUMBER.test(value)) fail();
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) fail('png-complexity-limit');
  return result;
}
function numbers(value, max = 32768) {
  const output = [];
  let position = 0;
  while (position < value.length) {
    const separator = /^[\s,]+/.exec(value.slice(position));
    if (separator) {position += separator[0].length; continue;}
    NUMBER_TOKEN.lastIndex = position;
    const token = NUMBER_TOKEN.exec(value);
    if (!token) fail();
    output.push(number(token[0]));
    if (output.length > max) fail('png-complexity-limit');
    position = NUMBER_TOKEN.lastIndex;
  }
  return output;
}
function length(value, nonnegative = false) {
  const match = /^(.*?)(%|px)?$/.exec(value);
  return String(number(match[1], nonnegative ? 0 : -1000000)) + (match[2] ?? '');
}
function fraction(value) {
  if (value.endsWith('%')) return String(number(value.slice(0, -1), 0, 100)) + '%';
  return String(number(value, 0, 1));
}
function color(value) {
  const lower = value.toLowerCase();
  if (COLORS.has(lower) || /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) return lower;
  const match = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/i.exec(value);
  if (!match) fail();
  const kind = match[1].toLowerCase(), values = match[2].split(',').map(part => part.trim());
  if (values.length !== (kind.endsWith('a') ? 4 : 3)) fail();
  const normalized = values.map((part, index) => {
    if (index === 3) return fraction(part);
    if (kind.startsWith('hsl')) {
      if (index === 0) return String(number(part, -360000, 360000));
      if (!part.endsWith('%')) fail();
      return String(number(part.slice(0, -1), 0, 100)) + '%';
    }
    return part.endsWith('%') ? String(number(part.slice(0, -1), 0, 100)) + '%' : String(number(part, 0, 255));
  });
  return kind + '(' + normalized.join(',') + ')';
}
function localUrl(value) {
  const match = /^url\(\s*(?:#([A-Za-z_][A-Za-z0-9_-]{0,63})|"#([A-Za-z_][A-Za-z0-9_-]{0,63})"|'#([A-Za-z_][A-Za-z0-9_-]{0,63})')\s*\)$/.exec(value);
  if (!match) fail();
  return 'url(#' + (match[1] ?? match[2] ?? match[3]) + ')';
}
function property(name, value) {
  if (!PROPERTIES.has(name) || value.length > 1024) fail();
  if (Object.hasOwn(ENUMS, name)) {
    if (!ENUMS[name].includes(value)) fail();
    return value;
  }
  if (name === 'fill' || name === 'stroke') return value === 'none' ? value : value.startsWith('url(') ? localUrl(value) : color(value);
  if (name === 'color' || name === 'stop-color') return color(value);
  if (name.endsWith('opacity')) return fraction(value);
  if (name === 'stroke-width') return length(value, true);
  if (name === 'stroke-dashoffset') return length(value);
  if (name === 'stroke-miterlimit') return String(number(value, 1, 1000));
  if (name === 'clip-path') return value === 'none' ? value : localUrl(value);
  if (name === 'stroke-dasharray') {
    if (value === 'none') return value;
    const parts = value.split(/[\s,]+/).filter(Boolean);
    if (!parts.length || parts.length > 64) fail('png-complexity-limit');
    const result = parts.map(part => length(part, true));
    // Tiny repeated dashes can otherwise create enormous rasterization work.
    if (result.some(part => parseFloat(part) > 0 && parseFloat(part) < 0.1)) fail('png-complexity-limit');
    return result.join(' ');
  }
  fail();
}
function declarations(value) {
  if (value.length > 8192) fail('png-complexity-limit');
  if (/[\\@{}!\/]/.test(value)) fail(); // No escapes, comments, at-rules, or hidden CSS resources.
  const output = {};
  let count = 0;
  for (const part of value.split(';')) {
    if (!part.trim()) continue;
    if (++count > 48) fail('png-complexity-limit');
    const separator = part.indexOf(':');
    if (separator < 1) fail();
    const key = part.slice(0, separator).trim().toLowerCase();
    output[key] = property(key, part.slice(separator + 1).trim());
  }
  return output;
}
function selector(value) {
  const match = /^(\*|[A-Za-z][A-Za-z0-9]*)?((?:[.#][A-Za-z_][A-Za-z0-9_-]{0,63})*)$/.exec(value.trim());
  if (!match || !match[0]) fail();
  const tag = match[1] ?? '*', ids = [], classes = [];
  if (tag !== '*' && !ELEMENTS.has(tag)) fail();
  for (const token of match[2].matchAll(/([.#])([A-Za-z_][A-Za-z0-9_-]*)/g)) (token[1] === '#' ? ids : classes).push(token[2]);
  if (ids.length > 1 || classes.length > 8) fail('png-complexity-limit');
  return {tag, id: ids[0], classes, weight: ids.length * 100 + classes.length * 10 + Number(tag !== '*')};
}
function stylesheet(value, rules) {
  if (value.length > 32768 || /[\\@\/]/.test(value)) fail();
  let position = 0;
  while (position < value.length) {
    const tail = value.slice(position);
    if (!tail.trim()) break;
    const open = value.indexOf('{', position), close = value.indexOf('}', open + 1);
    if (open < 0 || close < 0) fail();
    const props = declarations(value.slice(open + 1, close));
    for (const part of value.slice(position, open).split(',')) {
      rules.push({...selector(part), props});
      if (rules.length > 128) fail('png-complexity-limit');
    }
    position = close + 1;
  }
}
function multiply(a, b) {
  const result = [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  if (result.some(value => !Number.isFinite(value) || Math.abs(value) > 1000000)) fail('png-complexity-limit');
  return result;
}
function transform(value) {
  let position = 0, count = 0, matrix = IDENTITY;
  while (position < value.length) {
    const match = /^\s*,?\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*/.exec(value.slice(position));
    if (!match) fail();
    if (++count > 32) fail('png-complexity-limit');
    const parts = numbers(match[2], 6), name = match[1];
    let next;
    if (name === 'matrix' && parts.length === 6) next = parts;
    else if (name === 'translate' && [1, 2].includes(parts.length)) next = [1, 0, 0, 1, parts[0], parts[1] ?? 0];
    else if (name === 'scale' && [1, 2].includes(parts.length)) next = [parts[0], 0, 0, parts[1] ?? parts[0], 0, 0];
    else if (name === 'rotate' && [1, 3].includes(parts.length)) {
      const rad = parts[0] * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const x = parts[1] ?? 0, y = parts[2] ?? 0;
      next = [cos, sin, -sin, cos, x - cos * x + sin * y, y - sin * x - cos * y];
    } else if ((name === 'skewX' || name === 'skewY') && parts.length === 1 && Math.abs(parts[0]) < 89) {
      const tangent = Math.tan(parts[0] * Math.PI / 180);
      next = name === 'skewX' ? [1, 0, tangent, 1, 0, 0] : [1, tangent, 0, 1, 0, 0];
    } else fail();
    matrix = multiply(matrix, next);
    position += match[0].length;
  }
  return matrix;
}
function path(value, budget, node) {
  const arity = {M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0};
  let position = 0, command = null, count = 0, started = false;
  const segmentStart = budget.segments;
  let magnitude = 0, arcRadius = 0, arcRatio = 1;
  const check = () => {
    if (command === null) return;
    const size = arity[command.toUpperCase()];
    if (size === 0 ? count !== 0 : count === 0 || count % size !== 0) fail('png-invalid-svg');
    budget.segments += size === 0 ? 1 : count / size;
    if (budget.segments > MAX_SEGMENTS) fail('png-complexity-limit');
  };
  while (position < value.length) {
    const char = value[position];
    if (/[\s,]/.test(char)) {position++; continue;}
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(char)) {
      check();
      if (!started && char.toUpperCase() !== 'M') fail('png-invalid-svg');
      started = true; command = char; count = 0; position++; continue;
    }
    NUMBER_TOKEN.lastIndex = position;
    const match = NUMBER_TOKEN.exec(value);
    if (!match || command === null || command.toUpperCase() === 'Z') fail('png-invalid-svg');
    const item = number(match[0]);
    if (command.toUpperCase() === 'A') {
      const slot = count % 7;
      if (slot === 0) arcRadius = item;
      else if (slot === 1 && item > 0 && arcRadius > 0) arcRatio = Math.max(arcRatio, item / arcRadius, arcRadius / item);
      if (slot < 2 && item < 0 || (slot === 3 || slot === 4) && item !== 0 && item !== 1) fail('png-invalid-svg');
    }
    magnitude += Math.abs(item);
    count++; budget.numbers++;
    if (budget.numbers > MAX_NUMBERS) fail('png-complexity-limit');
    position = NUMBER_TOKEN.lastIndex;
  }
  check();
  // Conservative geometric length, including smooth control reflection and arc
  // radius correction. Used only to bound dash expansion after CSS/inheritance.
  node.lengthBound = 8 * (budget.segments - segmentStart + 1) * (magnitude + 1) * arcRatio;
  return value;
}
function attribute(node, name, value, budget) {
  if (PROPERTIES.has(name)) return property(name, value);
  if (name === 'transform' || name === 'gradientTransform') {
    const matrix = transform(value);
    if (name === 'transform') node.matrix = matrix;
    return 'matrix(' + matrix.join(' ') + ')';
  }
  if (LENGTHS.has(name)) return length(value, ['r', 'rx', 'ry', 'fr', 'width', 'height'].includes(name));
  if (name === 'd') return path(value, budget, node);
  if (name === 'points') {
    const parts = numbers(value, 16384);
    budget.numbers += parts.length;
    budget.segments += Math.max(0, parts.length / 2 - 1) + Number(node.name === 'polygon' && parts.length > 0);
    if (parts.length % 2 || budget.numbers > MAX_NUMBERS || budget.segments > MAX_SEGMENTS) fail('png-complexity-limit');
    node.lengthBound = parts.reduce((sum, value) => sum + Math.abs(value), 0) * 2 + 1;
    return parts.join(' ');
  }
  if (name === 'pathLength') return String(number(value, 0.1));
  if (name === 'viewBox') {
    const parts = numbers(value, 4);
    if (parts.length !== 4 || parts[2] < 0.001 || parts[3] < 0.001) fail('png-invalid-svg');
    return parts.join(' ');
  }
  if (name === 'preserveAspectRatio') {
    if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value)) fail();
    return value;
  }
  if (name === 'offset') return fraction(value);
  if (name === 'gradientUnits' || name === 'clipPathUnits') {
    if (!['objectBoundingBox', 'userSpaceOnUse'].includes(value)) fail();
    return value;
  }
  if (name === 'spreadMethod') {
    if (!['pad', 'reflect', 'repeat'].includes(value)) fail();
    return value;
  }
  if (name === 'href') {
    if (!value.startsWith('#') || !ID.test(value.slice(1))) fail();
    return value;
  }
  if (name === 'version' && ['1.0', '1.1', '2.0'].includes(value)) return value;
  if (name === 'type' && value === 'text/css') return value;
  fail();
}

// This is an intentionally small SVG language, not a blacklist. saxes owns XML
// structure/namespaces; all accepted nodes/values are rebuilt. CSS is parsed into
// whitelisted presentation attributes, so no stylesheet reaches the renderer.
// No text/fonts, image/use/filter/mask/animation, foreign XML, or resource loaders.
export function sanitizeSvg(svg) {
  if (typeof svg !== 'string' || !svg.length) fail('png-invalid-input');
  if (svg.length > MAX_INPUT || Buffer.byteLength(svg, 'utf8') > MAX_INPUT) fail('png-input-limit');
  // No entity references, including numeric/predefined ones, are needed by this
  // shape-only language. Reject before SAX expansion, in addition to no DTD.
  if (svg.includes('&')) fail();
  const parser = new SaxesParser({xmlns: true, fragment: false});
  const stack = [], nodes = [], ids = new Map(), rules = [], budget = {numbers: 0, segments: 0};
  let root = null, resources = 0;
  parser.on('error', () => fail('png-invalid-svg'));
  parser.on('doctype', () => fail());
  parser.on('processinginstruction', () => fail());
  parser.on('xmldecl', declaration => {
    if (declaration.version !== '1.0' || declaration.encoding && !/^utf-?8$/i.test(declaration.encoding)) fail();
  });
  parser.on('opentag', tag => {
    if (tag.prefix || tag.uri !== '' && tag.uri !== SVG_NS || !ELEMENTS.has(tag.local)) fail();
    const name = tag.local, parent = stack.at(-1);
    if (!parent ? root !== null || name !== 'svg' : name === 'svg') fail('png-invalid-svg');
    if (nodes.length >= MAX_NODES || stack.length >= MAX_DEPTH || Object.keys(tag.attributes).length > 48) fail('png-complexity-limit');
    if (parent && !['svg', 'g', 'defs', 'clipPath', 'linearGradient', 'radialGradient'].includes(parent.name)) fail();
    if (parent && GRADIENTS.has(parent.name) && name !== 'stop') fail();
    if (name === 'stop' && !GRADIENTS.has(parent?.name)) fail();
    if (name === 'clipPath' || GRADIENTS.has(name)) {if (++resources > 256) fail('png-complexity-limit');}
    const inClip = name === 'clipPath' || parent?.inClip === true;
    if (parent?.inClip && name !== 'g' && !SHAPES.has(name)) fail();
    const node = {name, attrs: {}, inline: {}, classes: [], children: [], text: '', inClip, matrix: IDENTITY, parent};
    for (const attr of Object.values(tag.attributes)) {
      if (attr.uri === XMLNS_NS) {
        if (parent || !(attr.name === 'xmlns' && attr.value === SVG_NS || attr.name === 'xmlns:xlink' && attr.value === XLINK_NS)) fail();
        continue;
      }
      let key = attr.local;
      if (attr.prefix || attr.uri) {
        if (attr.prefix !== 'xlink' || attr.uri !== XLINK_NS || key !== 'href' || !GRADIENTS.has(name)) fail();
      }
      const value = attr.value.trim();
      if (Object.hasOwn(node.attrs, key)) fail('png-invalid-svg');
      if (key === 'id') {
        if (!ID.test(value) || ids.has(value)) fail();
        node.id = value; ids.set(value, node); node.attrs.id = value;
      } else if (key === 'class') {
        node.classes = value.split(/\s+/).filter(Boolean);
        if (node.classes.length > 16 || node.classes.some(part => !ID.test(part))) fail();
      } else if (key === 'style') node.inline = declarations(value);
      else {
        if (!(PROPERTIES.has(key) || key === 'transform' && (SHAPES.has(name) || ['svg', 'g', 'clipPath'].includes(name)) || ATTRIBUTES[name].has(key))) fail();
        node.attrs[key] = attribute(node, key, value, budget);
      }
    }
    if (parent) parent.children.push(node);
    else root = node;
    nodes.push(node); stack.push(node);
  });
  const text = value => {
    const node = stack.at(-1);
    if (!node || !['style', 'title', 'desc'].includes(node.name)) {
      if (value.trim()) fail('png-invalid-svg');
      return;
    }
    node.text += value;
    if (node.text.length > (node.name === 'style' ? 32768 : 2048)) fail('png-complexity-limit');
  };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => {
    const node = stack.pop();
    if (node.name === 'style') stylesheet(node.text, rules);
    node.text = '';
  });
  try {parser.write(svg).close();}
  catch (error) {if (error?.[OWN_ERROR]) throw error; fail('png-invalid-svg');}
  if (!root || stack.length) fail('png-invalid-svg');
  let references = 0, dashWork = 0;
  const view = root.attrs.viewBox ? root.attrs.viewBox.split(' ').map(Number) : null;
  const viewDimension = value => value && !value.endsWith('%') ? Number(value.replace(/px$/, '')) : SIZE;
  const width = view?.[2] ?? viewDimension(root.attrs.width), height = view?.[3] ?? viewDimension(root.attrs.height);
  const dimension = Math.max(width, height), dashDimension = Math.min(width, height);
  const geometryLength = value => value ? Math.abs(parseFloat(value)) * (value.endsWith('%') ? dimension / 100 : 1) : 0;
  for (const node of nodes) {
    const winners = {};
    for (const rule of rules) {
      if (rule.tag !== '*' && rule.tag !== node.name || rule.id && rule.id !== node.id || rule.classes.some(item => !node.classes.includes(item))) continue;
      for (const [key, value] of Object.entries(rule.props)) {
        if (!winners[key] || winners[key].weight <= rule.weight) winners[key] = {weight: rule.weight, value};
      }
    }
    for (const [key, entry] of Object.entries(winners)) node.attrs[key] = entry.value;
    Object.assign(node.attrs, node.inline);
    node.effectiveMatrix = multiply(node.parent?.effectiveMatrix ?? IDENTITY, node.matrix);
    node.stroke = node.attrs.stroke ?? node.parent?.stroke ?? 'none';
    node.dashes = node.attrs['stroke-dasharray'] ?? node.parent?.dashes ?? 'none';
    node.pathLength = node.attrs.pathLength;
    node.vectorEffect = node.attrs['vector-effect'] ?? node.parent?.vectorEffect ?? 'none';
    if (SHAPES.has(node.name) && node.stroke !== 'none' && node.dashes !== 'none') {
      const pattern = node.dashes.split(' ').map(value => Math.abs(parseFloat(value)) * (value.endsWith('%') ? dashDimension / 100 : 1));
      const period = pattern.reduce((sum, value) => sum + value, 0);
      // All-zero patterns are solid per SVG, never let a renderer dash-loop them.
      if (!period) node.attrs['stroke-dasharray'] = 'none';
      else {
        let lengthBound = node.lengthBound;
        if (lengthBound === undefined) {
          const a = node.attrs;
          lengthBound = node.name === 'circle' || node.name === 'ellipse'
            ? 8 * (geometryLength(a.r) + geometryLength(a.rx) + geometryLength(a.ry))
            : node.name === 'rect' ? 4 * (geometryLength(a.width) + geometryLength(a.height))
              : 2 * (geometryLength(a.x1) + geometryLength(a.x2) + geometryLength(a.y1) + geometryLength(a.y2) + 1);
        }
        const matrix = node.effectiveMatrix;
        const scale = Math.max(1, Math.abs(matrix[0]) + Math.abs(matrix[2]), Math.abs(matrix[1]) + Math.abs(matrix[3]))
          * (node.vectorEffect === 'non-scaling-stroke' ? Math.max(1, SIZE / dashDimension) : 1);
        // pathLength changes the user-unit/dash ratio and can amplify even a
        // two-point path. A tiny declared length must not bypass the work bound.
        const calibration = node.pathLength ? Math.max(1, lengthBound / Number(node.pathLength)) : 1;
        dashWork += lengthBound * scale * calibration * pattern.length / period + pattern.length;
        if (!Number.isFinite(dashWork) || dashWork > 1000000) fail('png-complexity-limit');
      }
    }
    for (const [key, value] of Object.entries(node.attrs)) {
      const reference = key === 'href' ? value.slice(1) : value.startsWith('url(#') ? value.slice(5, -1) : null;
      if (reference === null) continue;
      if (++references > 4096) fail('png-complexity-limit');
      const target = ids.get(reference);
      if (!target || (key === 'clip-path' ? target.name !== 'clipPath' : !GRADIENTS.has(target.name))) fail();
      // No recursive clip resources, gradient paint servers, or <use> expansion.
      if (node.inClip || GRADIENTS.has(node.name) && key !== 'href' || node.name === 'stop') fail();
      if (key === 'href') node.gradientParent = target;
    }
  }
  for (const node of nodes) {
    if (!GRADIENTS.has(node.name)) continue;
    const seen = new Set();
    let cursor = node;
    while (cursor) {
      if (seen.has(cursor) || seen.size >= 16) fail('png-complexity-limit');
      seen.add(cursor); cursor = cursor.gradientParent;
    }
  }
  if (!root.attrs.viewBox) {
    const dimension = value => value && !value.endsWith('%') ? number(value.replace(/px$/, ''), 0.001) : SIZE;
    root.attrs.viewBox = '0 0 ' + dimension(root.attrs.width) + ' ' + dimension(root.attrs.height);
  }
  root.attrs.width = String(SIZE); root.attrs.height = String(SIZE);
  root.attrs.xmlns = SVG_NS; root.attrs['xmlns:xlink'] = XLINK_NS;
  const parts = [];
  let outputBytes = 0;
  const emit = value => {outputBytes += Buffer.byteLength(value, 'utf8'); if (outputBytes > 512 * 1024) fail('png-complexity-limit'); parts.push(value);};
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  function serialize(node) {
    if (['style', 'title', 'desc'].includes(node.name)) return;
    emit('<' + node.name);
    for (const [key, value] of Object.entries(node.attrs)) emit(' ' + (key === 'href' ? 'xlink:href' : key) + '="' + escape(value) + '"');
    emit('>');
    for (const child of node.children) serialize(child);
    emit('</' + node.name + '>');
  }
  serialize(root);
  return parts.join('');
}

const require = createRequire(import.meta.url);
let initialization;
function initializeWasm() {
  // The sole explicit file read is a fixed installed package asset. Passing bytes
  // avoids initWasm's URL/fetch path; no font, image, file or network resolver.
  initialization ??= readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')).then(bytes => initWasm(bytes));
  return initialization;
}

// Trusted seams allow tests to prove free() on all failure paths. HTTP callers
// only use createPngRenderer; neither engine nor resource settings are input.
export async function renderSvg(svg, {initialize = initializeWasm, Renderer = Resvg} = {}) {
  let sanitized;
  try {sanitized = sanitizeSvg(svg);}
  finally {svg = null;}
  try {await initialize();}
  catch {sanitized = null; fail('png-unavailable');}
  let renderer, image;
  try {
    renderer = new Renderer(sanitized, {fitTo: {mode: 'original'}, font: {loadSystemFonts: false, fontFiles: [], fontDirs: []}});
    sanitized = null;
    if (renderer.width !== SIZE || renderer.height !== SIZE || renderer.imagesToResolve().length) fail('png-render-failed');
    image = renderer.render();
    if (image.width !== SIZE || image.height !== SIZE) fail('png-render-failed');
    const png = image.asPng();
    if (!(png instanceof Uint8Array)) fail('png-render-failed');
    if (png.byteLength > MAX_OUTPUT) fail('png-output-limit');
    // Own the transferable bytes, not a view into WASM memory being freed below.
    return Uint8Array.from(png);
  } catch (error) {
    if (error?.[OWN_ERROR]) throw error;
    fail('png-render-failed');
  } finally {
    sanitized = null;
    // Attempt both releases even if the engine throws during cleanup. Never leak
    // an engine exception (which can contain untrusted SVG) to the caller.
    let cleanupFailed = false;
    try {image?.free();} catch {cleanupFailed = true;}
    try {renderer?.free();} catch {cleanupFailed = true;}
    if (cleanupFailed) fail('png-render-failed');
  }
}

if (!isMainThread && parentPort) {
  let active = false;
  parentPort.on('message', async message => {
    const id = message?.id;
    if (!Number.isSafeInteger(id) || id < 1 || active) return;
    active = true;
    let svg = message.svg;
    message.svg = null;
    try {
      const promise = renderSvg(svg);
      svg = null;
      const png = await promise;
      parentPort.postMessage({id, ok: true, png}, [png.buffer]);
    } catch (error) {
      parentPort.postMessage({id, ok: false, code: error?.[OWN_ERROR] ? error.code : 'png-render-failed'});
    } finally {
      svg = null; active = false;
    }
  });
}
