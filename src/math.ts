// Minimal Math library for 3D WebGPU rendering

export class Vec3 {
  constructor(public x: number, public y: number, public z: number) {}

  static normalize(v: Vec3): Vec3 {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (len === 0) return new Vec3(0, 0, 0);
    return new Vec3(v.x / len, v.y / len, v.z / len);
  }

  static subtract(a: Vec3, b: Vec3): Vec3 {
    return new Vec3(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  static cross(a: Vec3, b: Vec3): Vec3 {
    return new Vec3(
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x
    );
  }

  static dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }
}

export class Mat4 {
  values: Float32Array;

  constructor() {
    this.values = new Float32Array(16);
    this.identity();
  }

  identity() {
    this.values.fill(0);
    this.values[0] = 1;
    this.values[5] = 1;
    this.values[10] = 1;
    this.values[15] = 1;
    return this;
  }

  static perspective(fov: number, aspect: number, near: number, far: number): Mat4 {
    const m = new Mat4();
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);

    m.values[0] = f / aspect;
    m.values[5] = f;
    m.values[10] = (far + near) * nf;
    m.values[11] = -1;
    m.values[14] = (2 * far * near) * nf;
    m.values[15] = 0;
    return m;
  }

  static lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
    const z = Vec3.normalize(Vec3.subtract(eye, center));
    const x = Vec3.normalize(Vec3.cross(up, z));
    const y = Vec3.normalize(Vec3.cross(z, x));

    const m = new Mat4();
    m.values[0] = x.x; m.values[4] = x.y; m.values[8] = x.z;
    m.values[1] = y.x; m.values[5] = y.y; m.values[9] = y.z;
    m.values[2] = z.x; m.values[6] = z.y; m.values[10] = z.z;
    m.values[12] = -Vec3.dot(x, eye);
    m.values[13] = -Vec3.dot(y, eye);
    m.values[14] = -Vec3.dot(z, eye);
    return m;
  }

  static multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Mat4();
    const ae = a.values;
    const be = b.values;
    const oe = out.values;

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += ae[k * 4 + i] * be[j * 4 + k];
        }
        oe[j * 4 + i] = sum;
      }
    }
    return out;
  }

  static rotateY(angle: number): Mat4 {
    const m = new Mat4();
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    m.values[0] = c;
    m.values[2] = -s;
    m.values[8] = s;
    m.values[10] = c;
    return m;
  }

  static rotateX(angle: number): Mat4 {
    const m = new Mat4();
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    m.values[5] = c;
    m.values[6] = s;
    m.values[9] = -s;
    m.values[10] = c;
    return m;
  }
}
