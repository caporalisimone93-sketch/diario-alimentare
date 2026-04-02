// 1. REGOLE DI BASE E CONFIGURAZIONE
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// Registrazione SW con pulizia cache per evitare vecchie versioni
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
        reg.update(); // Forza l'aggiornamento del file
    });
}

function salvaApiKey() {
    const key = document.getElementById('api-key-input').value.trim();
    if (key) {
        localStorage.setItem('gemini_api_key', key);
        alert("API Key salvata!");
        location.reload(); // Ricarica per applicare le modifiche
    }
}

function ottieniApiKey() { return localStorage.getItem('gemini_api_key'); }

// 2. DATABASE DEXIE
const db = new Dexie("DiarioAlimentareDB");
db.version(3).stores({ // Incrementata versione per sicurezza
    pastiTipici: 'nome, descrizione, calorie, proteine, carboidrati, grassi',
    diario: 'data, calorieMangiate, proteine, carbo, grassi, calorieBruciate'
});

// 3. FUNZIONE DI CHIAMATA API (CUORE DEL PROBLEMA)
async function faiDomandaAGemini(testo, apiKey) {
    const dataOggi = ottieniData(0);
    const tdee = await ottieniTDEEAttuale();
    
    // Prompt super-strutturato per evitare errori di interpretazione
    const promptSistema = `Sei un dietologo AI. Oggi è il ${dataOggi}. TDEE: ${tdee}kcal.
Analizza l'input e rispondi in modo naturale.
DEVI SEMPRE includere a fine risposta un blocco JSON con i valori da sommare al diario:
\`\`\`json
{"data_riferimento": "${dataOggi}", "calorie_mangiate": 0, "proteine": 0, "carboidrati": 0, "grassi": 0, "calorie_bruciate": 0}
\`\`\``;

    const payload = {
        contents: [{ parts: [{ text: `${promptSistema}\n\nUser: ${testo}` }] }]
    };

    // NOTA: Passiamo la chiave nell'URL (?key=) per massima compatibilità browser
    const response = await fetch(`${API_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const resData = await response.json();

    if (!response.ok) {
        // Se l'errore persiste, stampiamo l'intero oggetto per debuggare in console
        console.error("Errore API Dettagliato:", resData);
        throw new Error(resData.error?.message || "Errore sconosciuto");
    }

    const testoAI = resData.candidates[0].content.parts[0].text;

    // Estrazione JSON sicura
    try {
        const jsonMatch = testoAI.match(/```json([\s\S]*?)```/);
        if (jsonMatch) {
            const dati = JSON.parse(jsonMatch[1].trim());
            await aggiornaDiario(dati);
        }
    } catch (e) {
        console.error("Errore nel parsing del JSON dell'AI", e);
    }

    return testoAI;
}

// 4. LOGICA DI AGGIORNAMENTO DATI
async function aggiornaDiario(dati) {
    const dataT = dati.data_riferimento || ottieniData(0);
    const r = await db.diario.get(dataT) || { data: dataT, calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0 };
    
    // Sommiamo i nuovi dati a quelli esistenti
    await db.diario.put({
        ...r,
        calorieMangiate: (r.calorieMangiate || 0) + (Number(dati.calorie_mangiate) || 0),
        proteine: (r.proteine || 0) + (Number(dati.proteine) || 0),
        carbo: (r.carbo || 0) + (Number(dati.carboidrati) || 0), // mappatura corretta
        grassi: (r.grassi || 0) + (Number(dati.grassi) || 0),
        calorieBruciate: (r.calorieBruciate || 0) + (Number(dati.calorie_bruciate) || 0)
    });
}

// 5. INTERFACCIA E UTILITY (Inviate precedentemente, integrate qui)
async function inviaMessaggio() {
    const input = document.getElementById("user-input");
    const testo = input.value.trim();
    const key = ottieniApiKey();
    if (!testo || !key) return alert("Manca testo o API Key!");

    aggiungiMessaggio("Tu", testo);
    input.value = "";
    aggiungiMessaggio("Dietologo", "...");

    try {
        const risposta = await faiDomandaAGemini(testo, key);
        const pulita = risposta.replace(/```json[\s\S]*?```/g, "").trim();
        const chat = document.getElementById("chat-box");
        chat.lastElementChild.innerHTML = `<strong>Dietologo:</strong> ${pulita}`;
    } catch (e) {
        document.getElementById("chat-box").lastElementChild.innerHTML = `<strong>Errore:</strong> ${e.message}`;
    }
}

function ottieniData(g) {
    const d = new Date(); d.setDate(d.getDate() - g);
    return d.toISOString().split('T')[0];
}

async function ottieniTDEEAttuale() {
    const d = await db.diario.toArray();
    const last = d.reverse().find(x => x.tdee);
    return last ? last.tdee : 2000;
}

function aggiungiMessaggio(m, t) {
    const cb = document.getElementById("chat-box");
    const p = document.createElement("p");
    p.innerHTML = `<strong>${m}:</strong> ${t}`;
    cb.appendChild(p);
    cb.scrollTop = cb.scrollHeight;
}

document.getElementById("user-input").addEventListener("keypress", e => { if(e.key==='Enter') inviaMessaggio(); });

// Funzioni Dashboard (mostraChat, mostraDashboard, disegnaGrafico) rimangono invariate.
function mostraChat() { document.getElementById("chat-section").style.display="block"; document.getElementById("dashboard-box").style.display="none"; }
function mostraDashboard() { document.getElementById("chat-section").style.display="none"; document.getElementById("dashboard-box").style.display="block"; disegnaGrafico(); }
