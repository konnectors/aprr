const {
  BaseKonnector,
  requestFactory,
  scrape,
  log,
  hydrateAndFilter,
  addData
} = require('cozy-konnector-libs')

const moment = require('moment')
moment.locale('fr')

const request = requestFactory({
  cheerio: true,
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true,
  debug: false,
  headers: {
    'Accept-Language': 'fr'
  }
})

const baseUrl = 'https://espaceclient.aprr.fr/aprr'
const loginUrl = baseUrl + '/Pages/connexion.aspx'
const billUrl = baseUrl + '/Pages/MaConsommation/conso_factures.aspx'
const consumptionUrl = baseUrl + '/_LAYOUTS/APRR-EDGAR/GetTrajets.aspx'

module.exports = new BaseKonnector(start)

async function start(fields) {
  await authenticate.bind(this)(fields.login, fields.password)

  log('info', 'Fetching the list of bills')
  let $ = await request(billUrl)

  log('info', 'Parsing bills')
  const bills = parseBills($)
  log('info', 'Saving data to Cozy')
  await this.saveBills(bills, fields, {
    identifiers: ['aprr'],
    contentType: 'application/pdf',
    requestInstance: request,
    fileIdAttributes: ['id'],
    keys: ['id']
  })

  log('info', 'Fetching the list of consumptions')
  $ = await fetchConsumptions(consumptionUrl)

  log('info', 'Parsing consumptions')
  const consumptions = parseConsumptions($)
  await saveConsumptions(consumptions)
}

async function authenticate(username, password) {
  return this.signin({
    requestInstance: request,
    url: loginUrl,
    formSelector: 'form',
    formData: $ => {
      const hiddenFields = {}
      $('input[type="hidden"]').each(function(i, elt) {
        hiddenFields[elt.attribs.name] = elt.attribs.value
      })
      return {
        ...hiddenFields,
        ctl00$PlaceHolderMain$ConsoBlocTemplateControl$ConnexionAscx$TbxLogin: username,
        ctl00$PlaceHolderMain$ConsoBlocTemplateControl$ConnexionAscx$TbxPassword: password,
        __EVENTTARGET:
          'ctl00$PlaceHolderMain$ConsoBlocTemplateControl$ConnexionAscx$LbnButtonConnection'
      }
    },
    json: false,
    simple: false,
    // the validate function will check if user is logged
    validate: (statusCode, $) => {
      if ($('#ctl00_customerArea_LbnDisconnect').length === 1) {
        return true
      } else {
        return false
      }
    }
  })
}

function parseBills($) {
  const bills = scrape(
    $,
    {
      id: 'td:nth-child(1)',
      amount: {
        sel: 'td:nth-child(3)',
        parse: amount => parseFloat(amount.replace(' €', '').replace(',', '.'))
      },
      date: {
        sel: 'td:nth-child(2)',
        parse: date => moment(date, 'MMM YYYY').add(moment().utcOffset(), 'm')
      }
    },
    '#divMyInvoicesContent table tbody tr'
  )

  return bills.map(bill => ({
    ...bill,
    vendorRef: bill.id,
    vendor: 'aprr',
    currency: '€',
    fileurl: `${billUrl}?facture=${bill.id}`,
    filename: `${bill.date.format('YYYY-MM')}_${String(bill.amount).replace(
      '.',
      ','
    )}€_${String(bill.id)}.pdf`,
    date: bill.date.toDate()
  }))
}

async function fetchConsumptions(consumptionUrl) {
  const requestJSON = requestFactory({
    cheerio: false,
    json: true,
    jar: true
  })

  return await requestJSON({
    uri: consumptionUrl,
    method: 'POST',
    body: {
      startIndex: '1',
      itemsCountInPage: '101'
    },
    json: true,
    headers: {
      'X-Requested-With': 'XMLHttpRequest'
    }
  })
}

function parseConsumptions(consumptions) {
  return consumptions.map(consumption => {
    return {
      badgeNumber: consumption.NumeroSupport,
      date: moment(consumption.Date, 'DD/MM/YYYY').toDate(),
      inPlace: consumption.GareEntreeLibelle,
      outPlace: consumption.GareSortieLibelle,
      amount: parseFloat(
        consumption.MontantHorsRemiseTTC.replace(' €', '').replace(',', '.')
      ),
      currency: '€',
      metadata: {
        dateImport: new Date(),
        vendor: 'aprr',
        version: 1
      }
    }
  })
}

function saveConsumptions(consumptions) {
  const DOCTYPE = 'io.cozy.aprr.consumptions'
  return hydrateAndFilter(consumptions, DOCTYPE, {
    keys: ['badgeNumber', 'date', 'inPlace', 'outPlace']
  }).then(entries => addData(entries, DOCTYPE))
}
