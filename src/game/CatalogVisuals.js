/**
 * Shared shop thumbnail language. Both the safehouse catalogue and the laptop
 * terminal render these same fixed vector silhouettes, so products stay
 * recognizable even though each surface has its own visual treatment.
 */

const FALLBACK = {
  label: "Quartermaster stock",
  code: "STOCK",
  paths: ["M20 18H76V49H20Z", "M28 26H68", "M28 34H58", "M28 42H64"],
};

const VISUALS = Object.freeze({
  pistol: {
    label: "Sidearm",
    code: "9MM",
    paths: ["M16 21H66L78 29H55L51 35H39L35 53H24L28 31H16Z", "M31 27H54"],
  },
  boomstick: {
    label: "Boomstick",
    code: "12G",
    paths: ["M10 25H70L87 30L70 35H47L34 46H18L32 33H10Z", "M43 25L53 17H64L58 25"],
  },
  smg: {
    label: "Submachine gun",
    code: "9×19",
    paths: ["M10 22H72L86 28L72 34H53L47 50H35L38 34H24L19 43H10L16 32H10Z", "M49 34L58 51H48L41 34"],
  },
  kick_master: {
    label: "Kick Master mod",
    code: "KICK",
    paths: ["M19 45L34 18H51L56 28L75 31L78 43L60 48L45 41L36 52Z", "M34 18L40 35", "M51 18L46 35"],
  },
  thick_skin: {
    label: "Thick Skin mod",
    code: "ARMOR",
    paths: ["M48 10L77 20V36C77 49 65 57 48 62C31 57 19 49 19 36V20Z", "M48 19V51", "M31 31H65"],
  },
  adrenaline_leak: {
    label: "Adrenaline Leak mod",
    code: "SURGE",
    paths: ["M12 35H29L37 18L48 51L58 27L65 35H84", "M20 14L25 19", "M76 14L71 19", "M20 56L25 51", "M76 56L71 51"],
  },
  scavenger_refund: {
    label: "Scavenger's Refund mod",
    code: "AMMO",
    paths: ["M18 46V23H32V46Z", "M41 46V15H55V46Z", "M64 46V27H78V46Z", "M14 51H82", "M22 23V17H28V23", "M45 15V9H51V15", "M68 27V21H74V27"],
  },
  standard: {
    label: "Standard Issue boots",
    code: "STEEL",
    paths: ["M23 13H43V37L59 43H78V54H31L19 46Z", "M43 26H25", "M33 54V58", "M68 54V58"],
  },
  explosive_kick: {
    label: "Semtex Soles",
    code: "BLAST",
    paths: ["M18 16H39V37L54 43H77V54H26L15 46Z", "M39 28H21", "M70 13L66 24", "M82 24L72 30", "M85 39L74 38"],
  },
  long_slide: {
    label: "Greased Brogues",
    code: "SLIDE",
    paths: ["M25 13H45V37L60 43H81V53H33L21 45Z", "M45 27H27", "M10 56H76", "M5 49H26", "M14 41H24"],
  },
  fast_sprint: {
    label: "Hare's Hoofs",
    code: "SPRINT",
    paths: ["M29 13H49V37L64 43H83V53H37L25 45Z", "M49 27H31", "M8 22H28", "M3 32H25", "M11 42H25"],
  },
});

export function catalogVisual(id) {
  return VISUALS[id] || FALLBACK;
}

/** Create a decorative, accessible-to-ignore thumbnail using only static SVG. */
export function createCatalogThumbnail(documentRef, id, className) {
  const visual = catalogVisual(id);
  const wrap = documentRef.createElement("div");
  wrap.className = className;
  wrap.setAttribute("aria-hidden", "true");
  wrap.title = visual.label;

  const svg = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 96 64");
  svg.setAttribute("focusable", "false");
  for (const d of visual.paths) {
    const path = documentRef.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  }
  wrap.appendChild(svg);

  const code = documentRef.createElement("span");
  code.textContent = visual.code;
  wrap.appendChild(code);
  return wrap;
}
