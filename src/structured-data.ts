import type { Cheerio, CheerioAPI } from "cheerio";

// Structured data found in a crawled page (JSON-LD and microdata), checked
// against the required and recommended properties Google documents for rich
// results. Only markup present in the HTML is reported.

type SchemaRule = {
  required?: string[];
  recommended?: string[];
  // Required only when the item is not nested in the thing it describes
  // (a standalone Review or AggregateRating must name itemReviewed).
  requiredWhenTopLevel?: string[];
  // Not required on the last element of a list (the last breadcrumb item).
  optionalOnLast?: string[];
  // Child items checked with another rule; "Offer|AggregateOffer" picks the
  // rule matching the child's own @type, defaulting to the first.
  nested?: Record<string, string>;
  // Rules that only apply inside a parent (an Offer on its own is not a rich result).
  nestedOnly?: boolean;
};

// From developers.google.com/search/docs/appearance/structured-data.
// "a|b" needs at least one of the properties; "a.b" is a nested property.
const schemaRules: Record<string, SchemaRule> = {
  Product: {
    required: ["name", "offers|review|aggregateRating"],
    nested: { offers: "Offer|AggregateOffer", review: "Review", aggregateRating: "AggregateRating" },
  },
  Offer: { nestedOnly: true, required: ["price", "priceCurrency"] },
  AggregateOffer: { nestedOnly: true, required: ["lowPrice", "priceCurrency"] },
  AggregateRating: { required: ["ratingValue", "ratingCount|reviewCount"], requiredWhenTopLevel: ["itemReviewed"] },
  Review: { required: ["author", "reviewRating"], requiredWhenTopLevel: ["itemReviewed"], nested: { reviewRating: "Rating" } },
  Rating: { nestedOnly: true, required: ["ratingValue"] },
  Article: { recommended: ["headline", "image", "datePublished", "author"] },
  BreadcrumbList: { required: ["itemListElement"], nested: { itemListElement: "ListItem" } },
  ListItem: { nestedOnly: true, required: ["position", "name|item.name", "item"], optionalOnLast: ["item"] },
  Organization: { required: ["name"], recommended: ["url", "logo"] },
  LocalBusiness: { required: ["name", "address"], recommended: ["telephone", "url"] },
  FAQPage: { required: ["mainEntity"], nested: { mainEntity: "Question" } },
  Question: { nestedOnly: true, required: ["name", "acceptedAnswer"], nested: { acceptedAnswer: "Answer" } },
  Answer: { nestedOnly: true, required: ["text"] },
  Event: { required: ["name", "startDate", "location"], recommended: ["description", "endDate", "image", "offers", "organizer"] },
  Recipe: { required: ["name", "image"], recommended: ["author", "description", "recipeIngredient", "recipeInstructions"] },
  JobPosting: {
    required: ["title", "description", "datePosted", "hiringOrganization", "jobLocation|applicantLocationRequirements"],
    recommended: ["baseSalary", "employmentType", "validThrough"],
  },
  VideoObject: { required: ["name", "thumbnailUrl", "uploadDate"], recommended: ["description", "duration", "contentUrl|embedUrl"] },
  SoftwareApplication: {
    required: ["name", "offers.price", "aggregateRating|review"],
    recommended: ["applicationCategory", "operatingSystem"],
    nested: { aggregateRating: "AggregateRating", review: "Review" },
  },
};

// Subtypes checked with their parent type's rules.
const schemaTypeAliases: Record<string, string> = {
  NewsArticle: "Article",
  BlogPosting: "Article",
  MobileApplication: "SoftwareApplication",
  WebApplication: "SoftwareApplication",
  VideoGame: "SoftwareApplication",
  ...aliases("Organization", "Corporation NGO OnlineBusiness OnlineStore NewsMediaOrganization EducationalOrganization"),
  ...aliases(
    "Event",
    "BusinessEvent ChildrensEvent ComedyEvent DanceEvent EducationEvent ExhibitionEvent Festival FoodEvent LiteraryEvent MusicEvent SaleEvent ScreeningEvent SocialEvent SportsEvent TheaterEvent",
  ),
  ...aliases(
    "LocalBusiness",
    "AnimalShelter AutomotiveBusiness AutoDealer AutoRepair ChildCare Dentist DryCleaningOrLaundry EmergencyService EmploymentAgency EntertainmentBusiness FinancialService AccountingService Bank InsuranceAgency FoodEstablishment Bakery BarOrPub CafeOrCoffeeShop FastFoodRestaurant Restaurant GovernmentOffice HealthAndBeautyBusiness BeautySalon DaySpa HairSalon HealthClub HomeAndConstructionBusiness Electrician GeneralContractor HVACBusiness HousePainter Locksmith MovingCompany Plumber RoofingContractor LegalService Attorney Notary Library LodgingBusiness BedAndBreakfast Hostel Hotel Motel Resort MedicalBusiness MedicalClinic Optician Pharmacy Physician ProfessionalService RealEstateAgent SelfStorage ShoppingCenter SportsActivityLocation Store BookStore ClothingStore ElectronicsStore FurnitureStore GroceryStore HardwareStore JewelryStore TravelAgency",
  ),
};

function aliases(rule: string, types: string) {
  return Object.fromEntries(types.split(" ").map((type) => [type, rule]));
}

export type StructuredDataItem = {
  format: "json-ld" | "microdata";
  type: string;
  missingRequired: string[];
  missingRecommended: string[];
};

const MAX_ITEMS_PER_PAGE = 20;
const MAX_MICRODATA_SCOPES = 200;

type Node = Record<string, unknown>;
type Refs = Map<string, Node>;

function isNode(value: unknown): value is Node {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

// "https://schema.org/Product" and "schema:Product" are both "Product".
function typeName(value: unknown) {
  return String(value || "").trim().replace(/^.*[/#:]/, "");
}

function ruleNameFor(type: string, allowNestedOnly = false) {
  const name = schemaRules[type] ? type : schemaTypeAliases[type] || "";
  return name && (allowNestedOnly || !schemaRules[name].nestedOnly) ? name : "";
}

// A JSON-LD reference ({"@id": "..."}) resolves to the node with that @id on the page.
function resolveNode(value: unknown, refs: Refs) {
  if (isNode(value) && typeof value["@id"] === "string" && Object.keys(value).length === 1) {
    return refs.get(value["@id"]) || value;
  }
  return value;
}

function collectIds(value: unknown, refs: Refs, depth = 0) {
  if (depth > 12) return;
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, refs, depth + 1);
    return;
  }
  if (!isNode(value)) return;
  const id = value["@id"];
  if (typeof id === "string" && Object.keys(value).length > 1 && !refs.has(id)) refs.set(id, value);
  for (const child of Object.values(value)) collectIds(child, refs, depth + 1);
}

function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(present);
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim() !== "";
}

function hasPath(value: unknown, path: string[], refs: Refs): boolean {
  if (Array.isArray(value)) return value.some((item) => hasPath(item, path, refs));
  if (!path.length) return present(value);
  const node = resolveNode(value, refs);
  return isNode(node) && hasPath(node[path[0]], path.slice(1), refs);
}

function checkRule(
  node: Node,
  ruleName: string,
  context: { prefix: string; topLevel: boolean; last: boolean; depth: number },
  refs: Refs,
  missing: { required: Set<string>; recommended: Set<string> },
) {
  const rule = schemaRules[ruleName];
  const label = (property: string) =>
    property
      .split("|")
      .map((alternative) => `${context.prefix}${alternative}`)
      .join(" or ");
  const has = (property: string) => property.split("|").some((alternative) => hasPath(node, alternative.split("."), refs));
  const required = [...(rule.required || []), ...(context.topLevel ? rule.requiredWhenTopLevel || [] : [])];
  for (const property of required) {
    if (context.last && rule.optionalOnLast?.includes(property)) continue;
    if (!has(property)) missing.required.add(label(property));
  }
  for (const property of rule.recommended || []) {
    if (!has(property)) missing.recommended.add(label(property));
  }
  if (context.depth >= 4) return;
  for (const [property, nestedRules] of Object.entries(rule.nested || {})) {
    const children = asArray(node[property])
      .map((child) => resolveNode(child, refs))
      .filter(isNode);
    const options = nestedRules.split("|");
    for (const [index, child] of children.entries()) {
      const ownRule = asArray(child["@type"])
        .map((type) => ruleNameFor(typeName(type), true))
        .find((name) => options.includes(name));
      checkRule(
        child,
        ownRule || options[0],
        { prefix: `${context.prefix}${property}.`, topLevel: false, last: index === children.length - 1, depth: context.depth + 1 },
        refs,
        missing,
      );
    }
  }
}

function describeItem(node: Node, format: StructuredDataItem["format"], refs: Refs): StructuredDataItem | null {
  const types = asArray(node["@type"]).map(typeName).filter(Boolean);
  if (!types.length) return null;
  const type = types.find((name) => ruleNameFor(name)) || types[0];
  const ruleName = ruleNameFor(type);
  const missing = { required: new Set<string>(), recommended: new Set<string>() };
  if (ruleName) checkRule(node, ruleName, { prefix: "", topLevel: true, last: false, depth: 0 }, refs, missing);
  return { format, type, missingRequired: [...missing.required], missingRecommended: [...missing.recommended] };
}

// Top-level JSON-LD items: the document itself, array members, and @graph members.
function jsonLdRoots(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdRoots);
  if (!isNode(value)) return [];
  const graph = asArray(value["@graph"]).filter(isNode);
  return [...(value["@type"] ? [value] : []), ...graph];
}

function microdataValue(item: Cheerio<any>) {
  const tag = String(item.prop("tagName") || "").toLowerCase();
  if (tag === "meta") return item.attr("content") || "";
  if (["a", "area", "link"].includes(tag)) return item.attr("href") || "";
  if (["audio", "embed", "iframe", "img", "source", "track", "video"].includes(tag)) return item.attr("src") || "";
  if (tag === "object") return item.attr("data") || "";
  if (tag === "time" && item.attr("datetime")) return item.attr("datetime") || "";
  if ((tag === "data" || tag === "meter") && item.attr("value")) return item.attr("value") || "";
  return item.attr("content") ?? item.text().replace(/\s+/g, " ").trim();
}

// Microdata items as JSON-LD-like nodes. Each itemprop belongs to its nearest
// itemscope ancestor; top-level items are scopes that are not a property.
function microdataRoots($: CheerioAPI) {
  const scopes = $("[itemscope]").toArray().slice(0, MAX_MICRODATA_SCOPES);
  const nodes = new Map<object, Record<string, unknown[]>>(
    scopes.map((scope) => [scope, { "@type": ($(scope).attr("itemtype") || "").split(/\s+/).filter(Boolean) }]),
  );
  $("[itemprop]").each((_, element) => {
    const owner = $(element).parent().closest("[itemscope]").get(0);
    const node = owner ? nodes.get(owner) : undefined;
    if (!node) return;
    const value = nodes.get(element) ?? microdataValue($(element));
    for (const name of ($(element).attr("itemprop") || "").split(/\s+/).filter(Boolean)) {
      node[name] ||= [];
      node[name].push(value);
    }
  });
  return scopes.filter((scope) => $(scope).attr("itemprop") === undefined).map((scope) => nodes.get(scope) as Node);
}

export function readStructuredData($: CheerioAPI) {
  const scripts = $('script[type="application/ld+json" i]');
  const parseErrors: string[] = [];
  const documents: unknown[] = [];
  scripts.each((_, script) => {
    const text = $(script).contents().text().trim();
    if (!text) return;
    try {
      documents.push(JSON.parse(text));
    } catch (error) {
      parseErrors.push(error instanceof Error ? error.message : "Invalid JSON-LD");
    }
  });
  const refs: Refs = new Map();
  collectIds(documents, refs);
  const microdata = microdataRoots($);
  const items: StructuredDataItem[] = [];
  const addItem = (node: Node, format: StructuredDataItem["format"]) => {
    const item = items.length < MAX_ITEMS_PER_PAGE ? describeItem(node, format, refs) : null;
    if (!item) return;
    items.push(item);
    // A page entity nested inline as mainEntity (WebPage -> Product) is its
    // own rich result candidate unless the parent's rules already check it.
    if (schemaRules[ruleNameFor(item.type)]?.nested?.mainEntity) return;
    for (const child of asArray(node.mainEntity)) {
      if (isNode(child) && asArray(child["@type"]).some((type) => ruleNameFor(typeName(type)))) addItem(child, format);
    }
  };
  for (const node of jsonLdRoots(documents)) addItem(node, "json-ld");
  for (const node of microdata) addItem(node, "microdata");
  return { jsonLdCount: scripts.length, parseErrors, microdataCount: microdata.length, items };
}
