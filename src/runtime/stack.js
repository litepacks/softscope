export class CallStack {
  constructor(initialCapacity = 256) {
    this.capacity = initialCapacity;
    this.stackIds = new Int32Array(this.capacity);
    this.stackStarts = new Float64Array(this.capacity);
    this.stackChildTimes = new Float64Array(this.capacity);
    this.stackPtr = 0;
  }

  _grow() {
    const newCapacity = this.capacity * 2;
    const newIds = new Int32Array(newCapacity);
    const newStarts = new Float64Array(newCapacity);
    const newChildTimes = new Float64Array(newCapacity);

    newIds.set(this.stackIds);
    newStarts.set(this.stackStarts);
    newChildTimes.set(this.stackChildTimes);

    this.capacity = newCapacity;
    this.stackIds = newIds;
    this.stackStarts = newStarts;
    this.stackChildTimes = newChildTimes;
  }

  enter(id, now) {
    const callerId = this.stackPtr > 0 ? this.stackIds[this.stackPtr - 1] : null;

    if (this.stackPtr >= this.capacity) {
      this._grow();
    }

    this.stackIds[this.stackPtr] = id;
    this.stackStarts[this.stackPtr] = now;
    this.stackChildTimes[this.stackPtr] = 0;
    this.stackPtr++;

    return callerId;
  }

  exit(id, now) {
    if (this.stackPtr === 0) {
      return { duration: 0, selfTime: 0, found: false };
    }

    // Common case: top of stack matches id
    if (this.stackIds[this.stackPtr - 1] === id) {
      const idx = this.stackPtr - 1;
      const duration = now - this.stackStarts[idx];
      const childTime = this.stackChildTimes[idx];
      const selfTime = duration > childTime ? duration - childTime : 0;

      if (idx > 0) {
        this.stackChildTimes[idx - 1] += duration;
      }

      this.stackPtr--;
      return { duration, selfTime, found: true };
    }

    // Interleaved / async case: find matching frame
    let idx = this.stackPtr - 2;
    while (idx >= 0 && this.stackIds[idx] !== id) {
      idx--;
    }

    if (idx >= 0) {
      const duration = now - this.stackStarts[idx];
      const childTime = this.stackChildTimes[idx];
      const selfTime = duration > childTime ? duration - childTime : 0;

      if (idx > 0) {
        this.stackChildTimes[idx - 1] += duration;
      }

      // Shift remaining items
      for (let i = idx; i < this.stackPtr - 1; i++) {
        this.stackIds[i] = this.stackIds[i + 1];
        this.stackStarts[i] = this.stackStarts[i + 1];
        this.stackChildTimes[i] = this.stackChildTimes[i + 1];
      }
      this.stackPtr--;

      return { duration, selfTime, found: true };
    }

    return { duration: 0, selfTime: 0, found: false };
  }

  get depth() {
    return this.stackPtr;
  }

  reset() {
    this.stackPtr = 0;
  }
}
