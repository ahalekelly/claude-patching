// Module-scoping helpers shared by the patches. The unpacked bundle is a
// concatenation of modules behind `//__CHUNK__ <name>` marker lines, and
// minified names are per module: a name probed in one module is a different
// binding anywhere else, so a search for a probed name stays inside the
// module it came from, and a binding used from another module is resolved
// through that module's import of it.
//
// `source` returns the current bundle text — patches splice it as they go,
// so an offset is only valid against the text it was taken from. `fail`
// takes one message and exits.
export function bundleTools(source, fail) {
  const esc = (s) => s.replace(/\$/g, "\\$");

  function chunkAt(at) {
    const js = source();
    const preceded = js.lastIndexOf("\n//__CHUNK__ ", at);
    if (preceded === -1 && !js.startsWith("//__CHUNK__ "))
      fail("no chunk marker precedes the match — refusing");
    const marker = preceded + 1; // the first module's marker sits at byte zero
    const nameEnd = js.indexOf("\n", marker);
    let end = js.indexOf("\n//__CHUNK__ ", nameEnd);
    if (end === -1) end = js.length;
    return {
      name: js.slice(marker + 12, nameEnd),
      start: nameEnd + 1,
      text: js.slice(nameEnd + 1, end),
    };
  }

  function onlyIn(label, text, regex) {
    const matches = [...text.matchAll(regex)];
    if (matches.length !== 1)
      fail(`${label}: ${matches.length} matches, expected exactly 1 — bundle layout changed, refusing`);
    return matches[0];
  }

  function only(label, regex) {
    return onlyIn(label, source(), regex);
  }

  // For patches whose probes and edits must all sit in one module: records the
  // first site's module and refuses a later site in another one.
  function oneModule() {
    let owner;
    return (label, at) => {
      const { name } = chunkAt(at);
      if (owner === undefined) owner = name;
      else if (name !== owner)
        fail(`${label} is in ${name} but this patch's other sites are in ${owner} — refusing`);
      return name;
    };
  }

  function aliasOf(label, list, local) {
    const hits = [
      ...`,${list},`.matchAll(new RegExp(`,${esc(local)}(?: as ([$\\w]+))?,`, "g")),
    ];
    if (hits.length !== 1)
      fail(`${label}: ${hits.length} entries for ${local}, expected exactly 1 — refusing`);
    return hits[0][1] ?? local;
  }

  function importedAs(label, defAt, local, site) {
    const def = chunkAt(defAt);
    const exports = [...def.text.matchAll(/export\{([^{}]*)\}/g)].map((m) => m[1]).join(",");
    const exported = aliasOf(`${label} export`, exports, local);
    const imports = [
      ...site.text.matchAll(/import\{([^{}]*)\}from"[^"]*\/([^"\/]+\.js)"/g),
    ].filter((m) => new RegExp(`,${esc(exported)}(?: as [$\\w]+)?,`).test(`,${m[1]},`));
    if (imports.length !== 1)
      fail(
        `${label}: ${site.name} imports ${exported} in ${imports.length} statements, expected exactly 1 — refusing`,
      );
    if (imports[0][2] !== def.name)
      fail(
        `${label}: ${site.name} imports ${exported} from ${imports[0][2]}, but it is defined in ${def.name} — refusing`,
      );
    return aliasOf(`${label} import`, imports[0][1], exported);
  }

  return { esc, chunkAt, only, onlyIn, oneModule, importedAs };
}
