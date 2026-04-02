// 1. REGOLE DI BASE E CONFIGURAZIONE
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent";

// Registrazione SW
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
        reg.update();
    });
}

function salvaApiKey() {
    const key = document.getElementById('api-key-input').value.trim();
    if (key) {
        localStorage.setItem('gemini_api_key', key);
        alert("API Key salvata!");
        location.reload();
    }
}

function ottieniApiKey() { return localStorage.getItem('gemini_api_key'); }

// 2. DATABASE DEXIE
const db = new Dexie("DiarioAlimentareDB");
db.version(3).stores({
    pastiTipici: 'nome, descrizione, calorie, proteine, carboidrati, grassi',
    diario: 'data, calorieMangiate, proteine, carbo, grassi, calorieBruciate'
});

// 3. FUNZIONE DI CHIAMATA API
async function faiDomandaAGemini(testo, apiKey) {
    const dataOggi = ottieniData(0);
    const tdee = await ottieniTDEEAttuale();

    const promptSistema = `Sei un dietologo AI. Oggi è il ${dataOggi}. TDEE: ${tdee}kcal.
Analizza l'input e rispondi in modo naturale.
DEVI SEMPRE includere a fine risposta un blocco JSON con i valori da sommare al diario:
\`\`\`json
{"data_riferimento": "${dataOggi}", "calorie_mangiate": 0, "proteine": 0, "carboidrati": 0, "grassi": 0, "calorie_bruciate": 0}
\`\`\``;

    const payload = {
        system_instruction: {
            parts: [{ text: promptSistema }]
        },
        contents: [
            { role: "user", parts: [{ text: testo }] }
        ]
    };

    const response = await fetch(`${API_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const resData = await response.json();

    if (!response.ok) {
        console.error("Errore API Dettagliato:", resData);
        throw new Error(resData.error?.message || "Errore sconosciuto");
    }

    const testoAI = resData.candidates[0].content.parts[0].text;

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

    await db.diario.put({
        ...r,
        calorieMangiate: (r.calorieMangiate || 0) + (Number(dati.calorie_mangiate) || 0),
        proteine: (r.proteine || 0) + (Number(dati.proteine) || 0),
        carbo: (r.carbo || 0) + (Number(dati.carboidrati) || 0),
        grassi: (r.grassi || 0) + (Number(dati.grassi) || 0),
        calorieBruciate: (r.calorieBruciate || 0) + (Number(dati.calorie_bruciate) || 0)
    });
}

// 5. INTERFACCIA E UTILITY
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

document.getElementById("user-input").addEventListener("keypress", e => { if (e.key === 'Enter') inviaMessaggio(); });

// 6. DASHBOARD
function mostraChat() {
    document.getElementById("chat-section").style.display = "block";
    document.getElementById("dashboard-box").style.display = "none";
}

function mostraDashboard() {
    document.getElementById("chat-section").style.display = "none";
    document.getElementById("dashboard-box").style.display = "block";
    disegnaGrafico();
}

let filtroAttuale = 'oggi';
let metricaAttuale = 'base';
let metricaFisicaAttuale = 'peso';

function cambiaFiltro(f) { filtroAttuale = f; disegnaGrafico(); }
function cambiaMetrica(m) { metricaAttuale = m; disegnaGrafico(); }
function cambiaMetricaFisica(m) { metricaFisicaAttuale = m; disegnaGraficoFisico(); }

let chartCalorie = null;
let chartFisico = null;

async function disegnaGrafico() {
    const tutti = await db.diario.toArray();
    const oggi = ottieniData(0);

    let filtrati;
    if (filtroAttuale === 'oggi') {
        filtrati = tutti.filter(x => x.data === oggi);
    } else if (filtroAttuale === 'settimana') {
        const sette = ottieniData(6);
        filtrati = tutti.filter(x => x.data >= sette && x.data <= oggi);
    } else {
        const trenta = ottieniData(29);
        filtrati = tutti.filter(x => x.data >= trenta && x.data <= oggi);
    }

    filtrati.sort((a, b) => a.data.localeCompare(b.data));

    const labels = filtrati.map(x => x.data);
    let dataset;

    if (metricaAttuale === 'base') {
        dataset = {
            label: 'Calorie mangiate',
            data: filtrati.map(x => x.calorieMangiate || 0),
            backgroundColor: 'rgba(0,123,255,0.5)',
            borderColor: '#007bff',
            borderWidth: 2
        };
    } else if (metricaAttuale === 'deficit') {
        dataset = {
            label: 'Deficit calorico',
            data: filtrati.map(x => (x.calorieBruciate || 0) - (x.calorieMangiate || 0)),
            backgroundColor: 'rgba(40,167,69,0.5)',
            borderColor: '#28a745',
            borderWidth: 2
        };
    } else if (metricaAttuale === 'proteine') {
        dataset = {
            label: 'Proteine (g)',
            data: filtrati.map(x => x.proteine || 0),
            backgroundColor: 'rgba(255,193,7,0.5)',
            borderColor: '#ffc107',
            borderWidth: 2
        };
    } else if (metricaAttuale === 'carboidrati') {
        dataset = {
            label: 'Carboidrati (g)',
            data: filtrati.map(x => x.carbo || 0),
            backgroundColor: 'rgba(253,126,20,0.5)',
            borderColor: '#fd7e14',
            borderWidth: 2
        };
    } else {
        dataset = {
            label: 'Grassi (g)',
            data: filtrati.map(x => x.grassi || 0),
            backgroundColor: 'rgba(220,53,69,0.5)',
            borderColor: '#dc3545',
            borderWidth: 2
        };
    }

    const ctx = document.getElementById('graficoCalorie').getContext('2d');
    if (chartCalorie) chartCalorie.destroy();
    chartCalorie = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [dataset] },
        options: { responsive: true, plugins: { legend: { display: true } } }
    });

    disegnaGraficoFisico();
}

async function disegnaGraficoFisico() {
    const tutti = await db.diario.toArray();
    const filtrati = tutti.filter(x => x.peso).sort((a, b) => a.data.localeCompare(b.data));

    const labels = filtrati.map(x => x.data);
    const data = metricaFisicaAttuale === 'peso'
        ? filtrati.map(x => x.peso)
        : filtrati.map(x => x.bmi);

    const ctx = document.getElementById('graficoFisico').getContext('2d');
    if (chartFisico) chartFisico.destroy();
    chartFisico = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: metricaFisicaAttuale === 'peso' ? 'Peso (kg)' : 'BMI',
                data,
                borderColor: metricaFisicaAttuale === 'peso' ? '#e83e8c' : '#6f42c1',
                backgroundColor: metricaFisicaAttuale === 'peso' ? 'rgba(232,62,140,0.2)' : 'rgba(111,66,193,0.2)',
                borderWidth: 2,
                fill: true,
                tension: 0.3
            }]
        },
        options: { responsive: true }
    });
}

// 7. PROFILO FISICO
async function salvaProfilo() {
    const peso = parseFloat(document.getElementById('input-peso').value);
    const altezza = parseFloat(document.getElementById('input-altezza').value);
    const eta = parseInt(document.getElementById('input-eta').value);
    const sesso = document.getElementById('input-sesso').value;

    if (!peso || !altezza || !eta) return alert("Compila tutti i campi!");

    const bmi = peso / ((altezza / 100) ** 2);

    // Formula Harris-Benedict per BMR
    let bmr;
    if (sesso === 'M') {
        bmr = 88.36 + (13.4 * peso) + (4.8 * altezza) - (5.7 * eta);
    } else {
        bmr = 447.6 + (9.2 * peso) + (3.1 * altezza) - (4.3 * eta);
    }
    const fattoreAttivita = parseFloat(document.getElementById('input-attivita').value);
alert("Fattore letto: " + fattoreAttivita); // <-- aggiungi questa riga
const tdee = Math.round(bmr * fattoreAttivita);

    const oggi = ottieniData(0);
    const r = await db.diario.get(oggi) || { data: oggi, calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0 };
    await db.diario.put({ ...r, peso, bmi: parseFloat(bmi.toFixed(1)), tdee });

    document.getElementById('risultato-profilo').innerHTML =
        `BMI: <strong>${bmi.toFixed(1)}</strong> | TDEE stimato: <strong>${tdee} kcal</strong>`;
}

// 8. RESET
async function resetDatiGiorno(giorniFA) {
    const data = ottieniData(giorniFA);
    const label = giorniFA === 0 ? "oggi" : "ieri";
    if (!confirm(`Sei sicuro di voler resettare i dati di ${label}?`)) return;
    await db.diario.delete(data);
    alert(`Dati di ${label} eliminati.`);
    disegnaGrafico();
}
