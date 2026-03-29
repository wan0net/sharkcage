import type { ToolDef } from "../agent/inference.ts";

const MEALS_API = Deno.env.get("MEALS_API_URL") ?? "http://localhost:8788";
const MEALS_TOKEN = Deno.env.get("MEALS_API_TOKEN") ?? "";

async function mealsRequest(method: string, path: string, body?: unknown): Promise<string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${MEALS_TOKEN}`,
  };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${MEALS_API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    return JSON.stringify({ error: `Meals API ${method} ${path}: ${res.status}`, detail: text });
  }
  return res.text();
}

export const mealToolDefs: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "meals_suggest",
      description: "Suggest meals based on what's in the fridge/freezer/pantry, recent history, and mood. Returns ranked recipe suggestions.",
      parameters: {
        type: "object",
        properties: {
          mood: {
            type: "string",
            enum: ["same", "rotate", "fresh", "quick"],
            default: "rotate",
            description: "How adventurous to be: same=repeat favourites, rotate=balanced variety, fresh=new recipes, quick=fastest cook time.",
          },
          portion_mode: {
            type: "string",
            enum: ["normal", "sick"],
            default: "normal",
            description: "Portion sizing mode. 'sick' yields smaller, gentler portions.",
          },
          guests: {
            type: "number",
            default: 0,
            description: "Number of additional guests to cook for beyond the household.",
          },
          max_cook_time: {
            type: "number",
            description: "Maximum cook time in minutes. Omit for no limit.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "meals_fridge",
      description: "List everything currently stored in the fridge, freezer, and pantry with quantities and best-before dates.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "meals_storage",
      description: "List items in a specific storage location (fridge, freezer, or pantry).",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            enum: ["fridge", "freezer", "pantry"],
            description: "Which storage location to query. Omit to list all.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "meals_ate",
      description: "Log that a meal was eaten. Updates fridge inventory by deducting consumed portions and records the meal in history.",
      parameters: {
        type: "object",
        properties: {
          recipe_name: {
            type: "string",
            description: "Name of the recipe that was eaten.",
          },
          servings_eaten: {
            type: "number",
            default: 2,
            description: "Number of servings consumed.",
          },
          portion_mode: {
            type: "string",
            enum: ["normal", "sick"],
            default: "normal",
            description: "Portion sizing mode used for this meal.",
          },
          guests: {
            type: "number",
            default: 0,
            description: "Number of guests who also ate.",
          },
          rating: {
            type: "string",
            enum: ["again", "good", "fine", "skip"],
            default: "good",
            description: "How the meal was rated: again=loved it, good=solid, fine=acceptable, skip=don't make again.",
          },
          notes: {
            type: "string",
            description: "Optional notes about the meal.",
          },
        },
        required: ["recipe_name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "meals_cooked",
      description: "Log that a recipe was cooked. Adds the resulting portions to fridge/freezer storage with best-before tracking.",
      parameters: {
        type: "object",
        properties: {
          recipe_name: {
            type: "string",
            description: "Name of the recipe that was cooked.",
          },
          servings: {
            type: "number",
            description: "Total number of servings produced.",
          },
          actual_servings_per_eat: {
            type: "number",
            default: 2,
            description: "How many servings are consumed per sitting.",
          },
          meal_type: {
            type: "string",
            enum: ["Complete Meal", "Component", "Base"],
            default: "Complete Meal",
            description: "Whether this is a full meal, a component (e.g. sauce), or a base (e.g. rice).",
          },
          best_before_days: {
            type: "number",
            default: 4,
            description: "How many days until this should be eaten or frozen.",
          },
          location: {
            type: "string",
            enum: ["fridge", "freezer"],
            default: "fridge",
            description: "Where to store the cooked food.",
          },
          notes: {
            type: "string",
            description: "Optional notes about the cook.",
          },
        },
        required: ["recipe_name", "servings"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "meals_pantry_add",
      description: "Add an item to the pantry, fridge, or freezer inventory.",
      parameters: {
        type: "object",
        properties: {
          item: {
            type: "string",
            description: "Name of the item to add.",
          },
          quantity: {
            type: "number",
            default: 1,
            description: "Amount of the item.",
          },
          unit: {
            type: "string",
            enum: ["g", "kg", "ml", "L", "each", "bunch", "pack", "loaf", "dozen"],
            default: "each",
            description: "Unit of measurement.",
          },
          category: {
            type: "string",
            enum: [
              "Meat & Seafood",
              "Produce",
              "Dairy & Eggs",
              "Pantry Staples",
              "Frozen",
              "Bakery",
              "Snacks",
              "Drinks",
              "Condiments",
              "Other",
            ],
            default: "Other",
            description: "Category of the item.",
          },
          location: {
            type: "string",
            description: "Optional storage location override (e.g. fridge, freezer, pantry).",
          },
        },
        required: ["item"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "meals_shopping",
      description: "Generate a shopping list for planned recipes, accounting for what's already in storage.",
      parameters: {
        type: "object",
        properties: {
          planned_recipes: {
            type: "array",
            items: { type: "string" },
            description: "List of recipe names to shop for.",
          },
          days: {
            type: "number",
            default: 7,
            description: "Number of days to plan for.",
          },
        },
        required: ["planned_recipes"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "meals_move",
      description: "Move a stored item between storage locations (e.g. fridge to freezer).",
      parameters: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "ID of the item to move.",
          },
          to_location: {
            type: "string",
            enum: ["fridge", "freezer", "pantry"],
            description: "Destination storage location.",
          },
          adjust_best_before: {
            type: "boolean",
            default: true,
            description: "Whether to automatically adjust the best-before date for the new location.",
          },
        },
        required: ["item_id", "to_location"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeMealTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "meals_suggest":
      return mealsRequest("POST", "/suggest", {
        mood: args.mood ?? "rotate",
        portion_mode: args.portion_mode ?? "normal",
        guests: args.guests ?? 0,
        ...(args.max_cook_time !== undefined && { max_cook_time: args.max_cook_time }),
      });

    case "meals_fridge":
      return mealsRequest("GET", "/fridge");

    case "meals_storage": {
      const path = args.location ? `/storage?location=${args.location}` : "/storage";
      return mealsRequest("GET", path);
    }

    case "meals_ate":
      return mealsRequest("POST", "/ate", {
        recipe_name: args.recipe_name,
        servings_eaten: args.servings_eaten ?? 2,
        portion_mode: args.portion_mode ?? "normal",
        guests: args.guests ?? 0,
        rating: args.rating ?? "good",
        ...(args.notes !== undefined && { notes: args.notes }),
      });

    case "meals_cooked":
      return mealsRequest("POST", "/cooked", {
        recipe_name: args.recipe_name,
        servings: args.servings,
        actual_servings_per_eat: args.actual_servings_per_eat ?? 2,
        meal_type: args.meal_type ?? "Complete Meal",
        best_before_days: args.best_before_days ?? 4,
        location: args.location ?? "fridge",
        ...(args.notes !== undefined && { notes: args.notes }),
      });

    case "meals_pantry_add":
      return mealsRequest("POST", "/pantry/add", {
        item: args.item,
        quantity: args.quantity ?? 1,
        unit: args.unit ?? "each",
        category: args.category ?? "Other",
        ...(args.location !== undefined && { location: args.location }),
      });

    case "meals_shopping":
      return mealsRequest("POST", "/shopping", {
        planned_recipes: args.planned_recipes,
        days: args.days ?? 7,
      });

    case "meals_move":
      return mealsRequest("POST", "/move", {
        item_id: args.item_id,
        to_location: args.to_location,
        adjust_best_before: args.adjust_best_before ?? true,
      });

    default:
      return `Unknown meal tool: ${name}`;
  }
}
