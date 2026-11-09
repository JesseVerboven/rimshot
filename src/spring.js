// Apple-style spring, parameterised by damping ratio + response (seconds).
// Interruptible by design: retargeting keeps the current value and velocity.
class Spring {
  constructor(value = 0, { damping = 1, response = 0.4 } = {}) {
    this.value = value
    this.velocity = 0
    this.target = value
    this.configure({ damping, response })
  }

  configure({ damping = this.damping, response = this.response } = {}) {
    this.damping = damping
    this.response = response
    // mass = 1  ->  k = (2π / response)², c = 4π·ζ / response
    this.stiffness = Math.pow((2 * Math.PI) / response, 2)
    this.friction = (4 * Math.PI * damping) / response
  }

  to(target, opts) {
    if (opts) this.configure(opts)
    if (opts && typeof opts.velocity === 'number') this.velocity = opts.velocity
    this.target = target
  }

  jump(value) {
    this.value = this.target = value
    this.velocity = 0
  }

  step(dt) {
    if (this.settled) return false
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
    const h = dt / steps
    for (let i = 0; i < steps; i++) {
      const accel = -this.stiffness * (this.value - this.target) - this.friction * this.velocity
      this.velocity += accel * h
      this.value += this.velocity * h
    }
    if (Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-3) {
      this.value = this.target
      this.velocity = 0
    }
    return true
  }

  get settled() {
    return this.value === this.target && this.velocity === 0
  }
}

// Momentum projection from "Designing Fluid Interfaces" (px/s -> px).
function projectMomentum(velocity, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)
}

function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}
