// Liquid glass layer.
//
// The refraction model (shape-aware normals, edge/rim falloff, gaussian
// sampling, tint) is adapted from liquid-glass-js by dashersw (MIT,
// https://github.com/dashersw/liquid-glass-js). That library samples a single
// html2canvas snapshot of the page; here every glass shape samples the *live*
// scene canvas each frame, so the CDs rolling underneath are refracted as they
// move. All shapes render in one WebGL pass.

const MAX_SHAPES = 8

const GLASS_VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const GLASS_FS = `
precision highp float;
uniform sampler2D u_scene;
uniform vec2 u_res;
uniform float u_dpr;
uniform int u_count;
uniform vec4 u_rect[${MAX_SHAPES}];   // x, y, w, h (device px, top-left origin)
uniform vec4 u_param[${MAX_SHAPES}];  // radius, darkTint, alpha, refraction strength
uniform vec4 u_color[${MAX_SHAPES}];  // rgb colour tint, a = amount

float sdRoundRect(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 blurSample(vec2 uv, float radius) {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  vec2 stepUv = (radius / 4.0) / u_res;
  for (int i = -4; i <= 4; i++) {
    for (int j = -4; j <= 4; j++) {
      vec2 o = vec2(float(i), float(j));
      float w = exp(-dot(o, o) / 9.0);
      acc += texture2D(u_scene, uv + o * stepUv).rgb * w;
      wsum += w;
    }
  }
  return acc / wsum;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec4 outCol = vec4(0.0);

  for (int i = 0; i < ${MAX_SHAPES}; i++) {
    if (i >= u_count) break;
    vec4 rect = u_rect[i];
    vec4 prm = u_param[i];
    vec2 hb = rect.zw * 0.5;
    vec2 p = px - (rect.xy + hb);
    float d = sdRoundRect(p, hb, prm.x);
    if (d > 1.0) continue;

    float coverage = clamp(0.5 - d, 0.0, 1.0) * prm.z;
    float inside = max(-d, 0.0);

    // Shape-aware outward normal from the SDF gradient.
    float e = 1.0;
    vec2 n = vec2(
      sdRoundRect(p + vec2(e, 0.0), hb, prm.x) - sdRoundRect(p - vec2(e, 0.0), hb, prm.x),
      sdRoundRect(p + vec2(0.0, e), hb, prm.x) - sdRoundRect(p - vec2(0.0, e), hb, prm.x)
    );
    n = length(n) > 1e-4 ? normalize(n) : vec2(0.0, -1.0);

    // Bezel: refraction is strongest at the rim and fades towards the centre.
    float bezel = min(24.0 * u_dpr, min(hb.x, hb.y));
    float t = clamp(inside / bezel, 0.0, 1.0);
    float bend = pow(1.0 - t, 2.2);
    float strength = prm.w;

    vec2 samplePx = px + n * bend * bezel * 0.9 * strength;
    vec2 uv = samplePx / u_res;

    vec3 col = blurSample(uv, 8.0 * u_dpr);

    // Chromatic fringe right at the bezel.
    float ca = bend * 2.0 * u_dpr * strength;
    vec3 fringe = vec3(
      texture2D(u_scene, (samplePx + n * ca) / u_res).r,
      texture2D(u_scene, uv).g,
      texture2D(u_scene, (samplePx - n * ca) / u_res).b
    );
    col = mix(col, fringe, bend * 0.35);

    // Dark-mode material: pull toward a deep neutral, then colour, then a vibrancy boost.
    col = mix(col, vec3(0.05, 0.05, 0.065), prm.y);
    col = mix(col, u_color[i].rgb, u_color[i].a);
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, 1.3);

    // Light catching the rim: bright on the top-left, softer bounce bottom-right.
    vec2 L = normalize(vec2(-0.45, -1.0));
    float rim = 1.0 - smoothstep(0.0, 1.5 * u_dpr, inside);
    float spec = pow(max(dot(n, L), 0.0), 1.4) * 0.55 + pow(max(dot(n, -L), 0.0), 1.4) * 0.2 + 0.07;
    col += rim * spec;
    col += bend * 0.05 * max(dot(n, L), 0.0);

    col = clamp(col, 0.0, 1.0);
    outCol.rgb = col * coverage + outCol.rgb * (1.0 - coverage);
    outCol.a = coverage + outCol.a * (1.0 - coverage);
  }

  gl_FragColor = outCol; // premultiplied
}
`

class GlassLayer {
  constructor(canvas, sourceCanvas) {
    this.canvas = canvas
    this.source = sourceCanvas
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: true, alpha: true })
    if (!gl) throw new Error('WebGL unavailable')
    this.gl = gl

    const program = this.link(GLASS_VS, GLASS_FS)
    gl.useProgram(program)
    this.program = program

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)

    const u = name => gl.getUniformLocation(program, name)
    this.loc = {
      scene: u('u_scene'),
      res: u('u_res'),
      dpr: u('u_dpr'),
      count: u('u_count'),
      rect: u('u_rect'),
      param: u('u_param'),
      color: u('u_color')
    }
    gl.uniform1i(this.loc.scene, 0)
    gl.clearColor(0, 0, 0, 0)

    this.rects = new Float32Array(MAX_SHAPES * 4)
    this.params = new Float32Array(MAX_SHAPES * 4)
    this.colors = new Float32Array(MAX_SHAPES * 4)
  }

  link(vsSrc, fsSrc) {
    const gl = this.gl
    const compile = (type, src) => {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
      return s
    }
    const p = gl.createProgram()
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    return p
  }

  resize(width, height, dpr) {
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.dpr = dpr
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
  }

  // shapes: [{ x, y, w, h, radius, tint, alpha, strength, color: [r,g,b,a] }] in CSS px
  render(shapes) {
    const gl = this.gl
    const dpr = this.dpr
    const n = Math.min(shapes.length, MAX_SHAPES)
    for (let i = 0; i < n; i++) {
      const s = shapes[i]
      this.rects.set([s.x * dpr, s.y * dpr, s.w * dpr, s.h * dpr], i * 4)
      this.params.set([s.radius * dpr, s.tint, s.alpha, s.strength], i * 4)
      this.colors.set(s.color || [0, 0, 0, 0], i * 4)
    }

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source)

    gl.uniform2f(this.loc.res, this.canvas.width, this.canvas.height)
    gl.uniform1f(this.loc.dpr, dpr)
    gl.uniform1i(this.loc.count, n)
    gl.uniform4fv(this.loc.rect, this.rects)
    gl.uniform4fv(this.loc.param, this.params)
    gl.uniform4fv(this.loc.color, this.colors)

    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }
}
