export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Povolena je pouze metoda POST." }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: "Na serveru chybí nastavený GEMINI_API_KEY v Environment variables na Netlify."
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Neplatný formát požadavku." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const rawText = (body?.text || "").trim();
  if (!rawText) {
    return new Response(JSON.stringify({ error: "Vlož prosím text receptu." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (rawText.length > 15000) {
    return new Response(JSON.stringify({ error: "Text receptu je příliš dlouhý (max 15 000 znaků)." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const prompt = `Jsi pomocník do české kuchařské aplikace. Tvým úkolem je vzít neupravený text receptu z poznámek a čistě ho rozdělit do strukturovaného JSONu v češtině.

Pravidla:
1. Vrať POUZE validní JSON objekt s těmito klíči:
   - "title": název receptu (krátký, výstižný, česky; pokud v textu chybí, vymysli vhodný podle surovin)
   - "mainCategory": buď "slane" nebo "sladke"
   - "subCategory": přesně jedno z těchto ID podle mainCategory:
     * pro "slane": "hlavni-jidla", "polevky", "testoviny-rizota", "salaty", "snidane-brunch", "pomazanky-chutovky", "pecivo-slane-kolace"
     * pro "sladke": "dorty", "buchty-kolace", "dezerty-pohary", "palacinky-livance", "susenky-cukrovi", "sladke-snidane"
   - "prepTime": celková doba přípravy (např. "30 min", "1 hod 15 min"). Pokud v textu není uvedena, realisticky ji odhadni ze surovin a postupu (včetně pečení/vaření).
   - "servings": počet porcí nebo kusů (např. "4 porce", "1 dort", "12 ks"). Pokud v textu není uveden, realisticky ho odhadni podle množství surovin.
   - "ingredients": pole řetězců (string[]), kde každá ingredience je samostatná položka bez odrážek na začátku (např. ["200 g hladké mouky", "2 vejce"]).
   - "instructions": přehledný postup jako jeden text, kroky očíslované (1., 2., 3. ...) a oddělené novým řádkem. Oprav zjevné překlepy, ale zachovej smysl receptu.
   - "notes": případné poznámky, tipy na servírování nebo varianty z textu. Pokud žádné nejsou, vrať prázdný řetězec "".

Text receptu z poznámek:
"""
${rawText}
"""`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const errDetail = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errDetail);
      return new Response(
        JSON.stringify({ error: "AI služba vrátila chybu. Zkontroluj API klíč nebo to zkus za chvilku." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const geminiData = await geminiRes.json();
    const textOut = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!textOut) {
      return new Response(
        JSON.stringify({ error: "AI nevrátila žádný výsledek. Zkus text trochu upravit." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const cleaned = textOut
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    const validSubs = {
      slane: [
        "hlavni-jidla",
        "polevky",
        "testoviny-rizota",
        "salaty",
        "snidane-brunch",
        "pomazanky-chutovky",
        "pecivo-slane-kolace"
      ],
      sladke: [
        "dorty",
        "buchty-kolace",
        "dezerty-pohary",
        "palacinky-livance",
        "susenky-cukrovi",
        "sladke-snidane"
      ]
    };

    const mainCategory = parsed.mainCategory === "sladke" ? "sladke" : "slane";
    const subCategory = validSubs[mainCategory].includes(parsed.subCategory)
      ? parsed.subCategory
      : validSubs[mainCategory][0];

    const result = {
      title: String(parsed.title || "").trim(),
      mainCategory,
      subCategory,
      prepTime: String(parsed.prepTime || "").trim(),
      servings: String(parsed.servings || "").trim(),
      ingredients: Array.isArray(parsed.ingredients)
        ? parsed.ingredients.map((i) => String(i).trim()).filter(Boolean)
        : [],
      instructions: String(parsed.instructions || "").trim(),
      notes: String(parsed.notes || "").trim()
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("Parse recipe error:", err);
    return new Response(
      JSON.stringify({ error: "Nepodařilo se zpracovat odpověď od AI. Zkus to prosím znovu." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
