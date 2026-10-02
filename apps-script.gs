// Receptor de registros — Registro de Clientes
// Pegar en: Google Sheets > Extensiones > Apps Script
// Luego: Implementar > Nueva implementacion > Aplicacion web
//   Ejecutar como: Yo | Acceso: Cualquier persona
// Copiar la URL y pegarla en Ajustes de la app.

// Seguridad: pon aqui una clave y la misma en Ajustes de la app.
// Si la dejas vacia (''), acepta todo (recomendado poner una).
const CLAVE = '';

const HEADERS = ['NOMBRES', 'TELEFONO', 'ESTADO', 'MOTIVO', 'FECHA Y HORA', 'SEGUIMIENTO', 'NOTAS'];

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
}

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (CLAVE && d.clave !== CLAVE) {
    return ContentService.createTextOutput('clave incorrecta');
  }
  const row = [d.nombre, d.telefono, d.estado, d.motivo, d.fechahora, d.seguimiento, d.notas];

  // 1) Historial: cada evento como fila nueva
  getSheet('Historial').appendRow(row);

  // 2) Estado actual: una fila por telefono, se actualiza si ya existe
  const cur = getSheet('Estado actual');
  const data = cur.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(d.telefono)) {
      cur.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return ContentService.createTextOutput('ok');
    }
  }
  cur.appendRow(row);
  return ContentService.createTextOutput('ok');
}

function doGet() {
  return ContentService.createTextOutput('ok');
}
