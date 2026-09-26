class JsonKeyScanner {
  index = 0;
  source: string;

  constructor(source: string) { this.source = source; }

  assertNoDuplicateKeys(): void {
    this.value();
    this.whitespace();
    if (this.index !== this.source.length) throw new Error('json_trailing_content');
  }

  whitespace(): void {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1;
  }

  string(): string {
    const start = this.index;
    if (this.source[this.index] !== '"') throw new Error('json_string_required');
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index]!;
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
      if (character === '\\') this.index += 2;
      else {
        if (character.charCodeAt(0) < 0x20) throw new Error('json_control_character');
        this.index += 1;
      }
    }
    throw new Error('json_unterminated_string');
  }

  value(): void {
    this.whitespace();
    const token = this.source[this.index];
    if (token === '"') { this.string(); return; }
    if (token === '{') { this.object(); return; }
    if (token === '[') { this.array(); return; }
    const start = this.index;
    while (this.index < this.source.length && !/[\s,\]}]/.test(this.source[this.index]!)) this.index += 1;
    if (this.index === start) throw new Error('json_value_required');
  }

  object(): void {
    this.index += 1;
    this.whitespace();
    if (this.source[this.index] === '}') { this.index += 1; return; }
    const keys = new Set<string>();
    while (this.index < this.source.length) {
      this.whitespace();
      const key = this.string();
      if (keys.has(key)) throw new Error('json_duplicate_object_key');
      keys.add(key);
      this.whitespace();
      if (this.source[this.index] !== ':') throw new Error('json_colon_required');
      this.index += 1;
      this.value();
      this.whitespace();
      if (this.source[this.index] === '}') { this.index += 1; return; }
      if (this.source[this.index] !== ',') throw new Error('json_object_separator_required');
      this.index += 1;
    }
    throw new Error('json_unterminated_object');
  }

  array(): void {
    this.index += 1;
    this.whitespace();
    if (this.source[this.index] === ']') { this.index += 1; return; }
    while (this.index < this.source.length) {
      this.value();
      this.whitespace();
      if (this.source[this.index] === ']') { this.index += 1; return; }
      if (this.source[this.index] !== ',') throw new Error('json_array_separator_required');
      this.index += 1;
    }
    throw new Error('json_unterminated_array');
  }
}

/** Parse JSON only when every object uses unique decoded property names. */
export function parseJsonWithoutDuplicateKeys<T = unknown>(source: string): T {
  new JsonKeyScanner(source).assertNoDuplicateKeys();
  return JSON.parse(source) as T;
}
