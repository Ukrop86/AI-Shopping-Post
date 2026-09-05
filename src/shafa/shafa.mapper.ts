import { ProductInput } from "../platform-types";
import { ShafaProduct, ShafaSizeSystem } from "./shafa.types";

function splitSizes(sizesStr: string): string[] {
  if (!sizesStr) return [];
  return sizesStr.split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

function fallbackKeywords(title: string, description: string): string[] {
  const words = (title + " " + description)
    .toLowerCase()
    .replace(/[^\wа-яёіїєґ\s]/gi, " ")
    .split(/\s+/)
    .filter(w => w.length > 3);
  return Array.from(new Set(words)).slice(0, 20);
}

export function mapProductToShafa(
  product: ProductInput,
  aiJson: string
): ShafaProduct {
  let ai: Record<string, unknown> = {};
  try {
    // Handle markdown code block anywhere in the response (e.g. prefixed with "I'm unable...")
    const codeMatch = aiJson.match(/```(?:json)?\s*([\s\S]+?)```/i);
    const clean = codeMatch
      ? codeMatch[1].trim()
      : aiJson.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    ai = JSON.parse(clean);
  } catch {
    // fallback: try to find raw JSON object in the text
    try {
      const objMatch = aiJson.match(/\{[\s\S]+\}/);
      if (objMatch) ai = JSON.parse(objMatch[0]);
    } catch { /* use empty ai */ }
  }

  const title = typeof ai.title === "string" ? ai.title : product.title;
  let description = typeof ai.description === "string" ? ai.description : aiJson;
  // Safety net: the Shafa prompt asks the AI to fold every concrete detail from the
  // seller's additional description (waist width, sleeve length, pockets, …) into the
  // description. If it didn't (the AI text doesn't already contain it), append it
  // verbatim so those details never get dropped from the listing.
  const extraDesc = (product.description || "").trim();
  if (extraDesc) {
    const descLc = description.toLowerCase();
    const probe = extraDesc.toLowerCase().slice(0, 40);
    if (!descLc.includes(probe)) {
      description = `${description.trim()}\n\n${extraDesc}`;
    }
  }
  const keywords = Array.isArray(ai.keywords) ? (ai.keywords as string[]) : fallbackKeywords(product.title, product.description || "");
  const colors = Array.isArray(ai.colors) ? (ai.colors as string[]).slice(0, 2) : [];

  // User-selected sizes from the UI take priority over AI output
  const userSizes = splitSizes(product.sizes || "");
  const sizes = userSizes.length > 0 ? userSizes : ["S", "M", "L"];
  const sizeSystem: ShafaSizeSystem = (product.sizeSystem as ShafaSizeSystem) || "Міжнародний";

  // Матеріали: з AI або з product.fabric
  let materials: string[] = [];
  if (Array.isArray(ai.materials) && ai.materials.length) {
    materials = ai.materials as string[];
  } else if (typeof ai.material === "string" && ai.material) {
    materials = [ai.material];
  } else if (product.fabric) {
    materials = product.fabric.split(/[,;\/]/).map(s => s.trim()).filter(Boolean);
  }

  return {
    title: title.slice(0, 150),
    description,
    price: product.price,
    condition: "Новий",
    keywords,
    imagePaths: product.photoPaths,
    categoryPath: ["Жіночий одяг", "Плаття", "Сукні міді"],
    quantity: "3",
    sizeSystem,
    sizes,
    colors,
    materials,
    sleeveLength: typeof ai.sleeveLength === "string" ? ai.sleeveLength : undefined,
    sleeveStyle: Array.isArray(ai.sleeveStyle) ? (ai.sleeveStyle as string[]) : [],
    seasons: Array.isArray(ai.seasons) ? (ai.seasons as string[]) : [],
    features: Array.isArray(ai.features) ? (ai.features as string[]) : [],
    silhouette: Array.isArray(ai.silhouette) ? (ai.silhouette as string[]) : [],
    fashionCut: Array.isArray(ai.fashionCut) ? (ai.fashionCut as string[]) : [],
    // Принт — тільки якщо є реальний принт (не однотонна/без принту)
    print: (() => {
      const p = Array.isArray(ai.print) ? (ai.print as string[]) : [];
      return p.filter(v => !/(однотон|без принт)/i.test(v));
    })(),
    style: (() => {
      const VALID_STYLES = ["Повсякденний","Діловий","Святковий","Вечірній","Романтичний","Бохо","Вінтажний","Готичний","Класичний","Спортивний"];
      const raw = Array.isArray(ai.style) ? (ai.style as string[]) : [];
      return raw.filter(v => VALID_STYLES.includes(v));
    })(),
    decor: typeof ai.decor === "string" ? ai.decor : undefined,
    modelFeatures: Array.isArray(ai.modelFeatures) ? (ai.modelFeatures as string[]) : [],
    madeInUkraine: undefined,
  };
}
