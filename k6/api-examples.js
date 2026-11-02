// Verifies every example query of k6/catalog.js (the ones in the README) against a live API.
//
//   k6 run k6/api-examples.js                                  # https://graphql.miqui.dev
//   k6 run -e BASE_URL=http://localhost:8080 k6/api-examples.js
//   k6 run -e SAMPLE=1 k6/api-examples.js                      # the literal values printed in the README
//
// The API must hold synced data (at least one successful sync run). `setup()` discovers real values
// (a big county, a small one, a city, a facility with several inspections, ...) so nothing here is
// hard-coded to today's data; assertions check properties (filters hold, order is newest first,
// pagination is disjoint and complete), not exact rows. One iteration; the run fails if any check fails.
import http from 'k6/http';
import { check, fail, group } from 'k6';
import { catalog, SAMPLE_CTX } from './catalog.js';

const BASE_URL = (__ENV.BASE_URL || 'https://graphql.miqui.dev').replace(/\/$/, '');

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

// Error cases answer HTTP 400 on purpose; don't count them as failed requests.
http.setResponseCallback(http.expectedStatuses(200, 400));

// ---------------------------------------------------------------- helpers
function gql(query, variables, operationName) {
  const payload = { query };
  if (variables !== undefined) payload.variables = variables;
  if (operationName) payload.operationName = operationName;
  const res = http.post(`${BASE_URL}/graphql`, JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'graphql' },
  });
  let body = null;
  try {
    body = res.json();
  } catch (_e) {
    // not JSON: leave null, checks will fail on it
  }
  const errors = body && body.errors ? body.errors : null;
  return {
    status: res.status,
    data: body ? body.data : null,
    errors,
    code: errors && errors[0] && errors[0].extensions ? errors[0].extensions.code : null,
  };
}

const ok = (r) => r.status === 200 && !r.errors && !!r.data;
const lc = (v) => String(v).toLowerCase();
const has = (text, term) => lc(text).includes(lc(term));
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isInt = (v) => Number.isInteger(v);
const isTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const sum = (a) => a.reduce((x, y) => x + y, 0);
/** Dates (ISO strings) sorted newest first; null dates, if any, only at the end. */
const newestFirst = (dates) => {
  const firstNull = dates.indexOf(null);
  const dated = firstNull === -1 ? dates : dates.slice(0, firstNull);
  const tail = firstNull === -1 ? [] : dates.slice(firstNull);
  return dated.every((d, i) => i === 0 || dated[i - 1] >= d) && tail.every((d) => d === null);
};
const badInput = (r) => r.status === 200 && r.code === 'BAD_USER_INPUT' && r.data === null;

// ---------------------------------------------------------------- discovery
export function setup() {
  if (__ENV.SAMPLE === '1') return Object.assign({}, SAMPLE_CTX); // README values; needs the dev data set
  const runs = gql('{ syncRuns(limit: 50, status: ok) { county result } }');
  if (!ok(runs) || runs.data.syncRuns.length === 0) {
    fail(`no successful sync runs at ${BASE_URL}: the API has no data to query (run the food-sync job first)`);
  }
  const seen = {}; // county -> facilitiesSeen of its newest successful run
  for (const run of runs.data.syncRuns) {
    if (!(run.county in seen)) seen[run.county] = (run.result && run.result.facilitiesSeen) || 0;
  }
  const counties = Object.keys(seen).sort((a, b) => seen[b] - seen[a]);
  const county = counties[0];
  const smalls = counties.filter((c) => seen[c] >= 30 && seen[c] <= 100);
  const smallCounty = smalls.length > 0 ? smalls[0] : counties[counties.length - 1];
  const smallTotal = gql(`{ facilities(county: "${smallCounty}") { totalCount } }`).data.facilities.totalCount;

  const sample = gql(`{ facilities(county: "${county}", first: 100) { nodes {
    id name city address lastInspectionScore
    inspections(first: 1) { totalCount nodes { id violations { id } } }
  } } }`);
  if (!ok(sample)) fail(`cannot read facilities of ${county}: ${JSON.stringify(sample.errors)}`);
  const nodes = sample.data.facilities.nodes;

  const cityCount = {};
  for (const n of nodes) cityCount[n.city] = (cityCount[n.city] || 0) + 1;
  const city = Object.keys(cityCount).sort((a, b) => cityCount[b] - cityCount[a])[0];

  const word = (text) => (text.match(/[A-Za-z]{4,}/) || [null])[0];
  const named = nodes.find((n) => n.city === city && n.lastInspectionScore >= 90 && word(n.name));
  const addressed = nodes.find((n) => word(n.address.split(/\r?\n/)[0]));
  const rich = nodes.find(
    (n) => n.inspections.totalCount >= 3 && n.inspections.nodes.length > 0 && n.inspections.nodes[0].violations.length > 0,
  );
  if (!named || !addressed || !rich) {
    fail(`county ${county} lacks the data the examples need (named=${!!named} addressed=${!!addressed} rich=${!!rich})`);
  }
  const ctx = {
    county,
    city,
    smallCounty,
    smallTotal,
    nameTerm: lc(word(named.name)),
    addrTerm: lc(word(addressed.address.split(/\r?\n/)[0])),
    facilityId: rich.id,
    inspectionId: rich.inspections.nodes[0].id,
  };
  console.log(`discovered ${JSON.stringify(ctx)}`);
  return ctx;
}

// ---------------------------------------------------------------- assertions, by query id
// Each returns [label, boolean] pairs. `r` is the array of step results (an array of pages for Q15).
const nodesOf = (r) => r.data.facilities.nodes;
const A = {
  Q1: (c, [r]) => [['responds with the root type name', ok(r) && r.data.__typename === 'Query']],
  Q2: (c, [r]) => [
    ['159 counties', ok(r) && r.data.counties.length === 159],
    ['upper case, includes the discovered county', ok(r) && r.data.counties.every((x) => x === x.toUpperCase()) && r.data.counties.includes(c.county)],
  ],
  Q3: (c, [r]) => {
    const names = ok(r) && r.data.__type ? r.data.__type.fields.map((f) => f.name) : [];
    return [['Facility exposes name, lastInspectionScore and inspections', ['name', 'lastInspectionScore', 'inspections'].every((n) => names.includes(n))]];
  },
  Q4: (c, [r]) => {
    const f = ok(r) && r.data.facilities;
    return [
      ['5 nodes, all in the county', !!f && f.nodes.length === 5 && f.nodes.every((n) => n.county === c.county)],
      ['totalCount > 5 and there is a next page', !!f && f.totalCount > 5 && f.pageInfo.hasNextPage === true && typeof f.pageInfo.endCursor === 'string'],
      ['scores are null or 0-100', !!f && f.nodes.every((n) => n.lastInspectionScore === null || (isInt(n.lastInspectionScore) && n.lastInspectionScore >= 0 && n.lastInspectionScore <= 100))],
    ];
  },
  Q5: (c, [r]) => {
    const f = ok(r) && r.data.facilities;
    const e = f ? f.edges : [];
    return [
      ['3 edges, each with a cursor and a node', !!f && e.length === 3 && e.every((x) => typeof x.cursor === 'string' && x.cursor.length > 0 && x.node.id)],
      ['startCursor/endCursor are the first/last edge cursors', !!f && f.pageInfo.startCursor === e[0].cursor && f.pageInfo.endCursor === e[2].cursor],
      ['forward-only: hasPreviousPage is false', !!f && f.pageInfo.hasPreviousPage === false],
    ];
  },
  Q6: (c, [r]) => [
    ['lower-case county matches', ok(r) && r.data.facilities.totalCount > 0],
    ['every node belongs to the (upper-case) county', ok(r) && nodesOf(r).every((n) => n.county === c.county)],
  ],
  Q7: (c, [r]) => [
    ['lower-case city matches', ok(r) && r.data.facilities.totalCount > 0],
    ['every node is in the city', ok(r) && nodesOf(r).every((n) => lc(n.city) === lc(c.city))],
  ],
  Q8: (c, [r]) => [
    ['the name search finds facilities', ok(r) && r.data.facilities.totalCount > 0],
    ['the term is in the name, address or city of every node', ok(r) && nodesOf(r).every((n) => has(`${n.name} ${n.address} ${n.city}`, c.nameTerm))],
  ],
  Q9: (c, [r]) => [
    ['the address search finds facilities', ok(r) && r.data.facilities.totalCount > 0],
    ['the term is in the name, address or city of every node', ok(r) && nodesOf(r).every((n) => has(`${n.name} ${n.address} ${n.city}`, c.addrTerm))],
  ],
  Q10: (c, [r]) => [
    ['there are perfect scores', ok(r) && r.data.facilities.totalCount > 0],
    ['every node scored 100', ok(r) && nodesOf(r).every((n) => n.lastInspectionScore === 100)],
  ],
  Q11: (c, [r]) => [
    ['matches exist', ok(r) && r.data.facilities.totalCount > 0],
    ['every node scored >= 95 and is in the county', ok(r) && nodesOf(r).every((n) => n.lastInspectionScore >= 95 && n.county === c.county)],
  ],
  Q12: (c, [r]) => [
    ['the combined filter still matches', ok(r) && r.data.facilities.totalCount > 0],
    ['city, term and score all hold for every node', ok(r) && nodesOf(r).every((n) => lc(n.city) === lc(c.city) && has(`${n.name} ${n.address} ${n.city}`, c.nameTerm) && n.lastInspectionScore >= 90)],
  ],
  Q13: (c, [r]) => [['lastInspectionDate is newest first (nulls last)', ok(r) && newestFirst(nodesOf(r).map((n) => n.lastInspectionDate))]],
  Q14: (c, [a, b]) => {
    const ida = ok(a) ? nodesOf(a).map((n) => n.id) : [];
    const idb = ok(b) ? nodesOf(b).map((n) => n.id) : [];
    const dates = (ok(a) ? nodesOf(a) : []).concat(ok(b) ? nodesOf(b) : []).map((n) => n.lastInspectionDate);
    return [
      ['page 1 returned a cursor', ok(a) && typeof a.data.facilities.pageInfo.endCursor === 'string'],
      ['page 2 has 3 nodes, none of them on page 1', idb.length === 3 && idb.every((id) => ida.indexOf(id) === -1)],
      ['the order continues across pages', newestFirst(dates)],
    ];
  },
  Q15: (c, [pages]) => {
    const good = pages.every(ok);
    const ids = good ? [].concat(...pages.map((p) => nodesOf(p).map((n) => n.id))) : [];
    const total = good ? pages[0].data.facilities.totalCount : -1;
    const unique = ids.filter((id, i) => ids.indexOf(id) === i).length;
    return [
      ['every page succeeded and the last one has no next page', good && pages[pages.length - 1].data.facilities.pageInfo.hasNextPage === false],
      ['the walk took ceil(totalCount / 25) pages', good && pages.length === Math.ceil(total / 25)],
      ['ids collected equal totalCount, with no duplicates', good && ids.length === total && unique === total],
    ];
  },
  Q16: (c, [r]) => [['totalCount is a positive integer', ok(r) && isInt(r.data.facilities.totalCount) && r.data.facilities.totalCount > 0]],
  Q17: (c, [r]) => {
    const f = ok(r) && r.data.facilities;
    return [['empty page: totalCount 0, no nodes, no next page, no cursor', !!f && f.totalCount === 0 && f.nodes.length === 0 && f.pageInfo.hasNextPage === false && f.pageInfo.endCursor === null]];
  },
  Q18: (c, [r]) => [
    ['historyPending is a boolean', ok(r) && nodesOf(r).every((n) => typeof n.historyPending === 'boolean')],
    ['updatedAt is a timestamp', ok(r) && nodesOf(r).every((n) => isTime(n.updatedAt))],
  ],
  Q19: (c, [r]) => [
    ['both aliases are answered', ok(r) && r.data.first.nodes.length === 1 && r.data.second.nodes.length === 1],
    ['each alias has its own totalCount', ok(r) && r.data.first.totalCount > 0 && r.data.second.totalCount > 0],
  ],
  Q20: (c, [r]) => [['the fragment fields are present on both nodes', ok(r) && nodesOf(r).length === 2 && nodesOf(r).every((n) => n.name && n.city && 'lastInspectionScore' in n && 'lastInspectionDate' in n)]],
  Q21: (c, [r]) => [['default variables applied: 3 nodes', ok(r) && nodesOf(r).length === 3]],
  Q22: (c, [r]) => {
    const off = gql(catalog.find((q) => q.id === 'Q22').steps[0].query(c), { full: false });
    return [
      ['full=true includes address and skips phone', ok(r) && nodesOf(r).every((n) => 'address' in n && !('phone' in n))],
      ['full=false skips address and includes phone', ok(off) && nodesOf(off).every((n) => !('address' in n) && 'phone' in n)],
    ];
  },
  Q23: (c, [r]) => {
    const step = catalog.find((q) => q.id === 'Q23').steps[0];
    const missing = gql(step.query(c));
    return [
      ['operationName picks the operation', ok(r) && r.data.__typename === 'Query'],
      ['without operationName: HTTP 400 OPERATION_RESOLUTION_FAILURE', missing.status === 400 && missing.code === 'OPERATION_RESOLUTION_FAILURE'],
    ];
  },
  Q24: (c, [r]) => [
    ['counties, facility and inspection come back together', ok(r) && r.data.counties.length === 159 && r.data.facility.name && isDate(r.data.inspection.inspectionDate)],
    ['the inspection has a 0-100 score', ok(r) && isInt(r.data.inspection.score) && r.data.inspection.score >= 0 && r.data.inspection.score <= 100],
  ],
  Q25: (c, [r]) => {
    const f = ok(r) && r.data.facility;
    return [
      ['the id round-trips', !!f && f.id === c.facilityId],
      ['text fields are filled', !!f && [f.name, f.address, f.city, f.county, f.permitType, f.permitNumber].every((v) => typeof v === 'string' && v.length > 0)],
      ['historyPending is boolean, updatedAt a timestamp', !!f && typeof f.historyPending === 'boolean' && isTime(f.updatedAt)],
    ];
  },
  Q26: (c, [r]) => {
    const i = ok(r) && r.data.facility.inspections;
    return [
      ['2 of 3+ inspections, with a next page', !!i && i.nodes.length === 2 && i.totalCount >= 3 && i.pageInfo.hasNextPage === true],
      ['newest first', !!i && newestFirst(i.nodes.map((n) => n.inspectionDate))],
      ['fields are typed', !!i && i.nodes.every((n) => n.id && isDate(n.inspectionDate) && typeof n.purpose === 'string' && (n.score === null || isInt(n.score)))],
    ];
  },
  Q27: (c, [a, b]) => {
    const x = ok(a) && a.data.facility.inspections.nodes[0];
    const y = ok(b) && b.data.facility.inspections.nodes[0];
    return [
      ['page 2 is a different inspection', !!x && !!y && x.id !== y.id],
      ['and an older (or same-day) one', !!x && !!y && y.inspectionDate <= x.inspectionDate],
    ];
  },
  Q28: (c, [r]) => [['totalCount >= 3', ok(r) && r.data.facility.inspections.totalCount >= 3]],
  Q29: (c, [r]) => [
    ['2 facilities with 2 inspections each', ok(r) && r.data.facilities.edges.length === 2 && r.data.facilities.edges.every((e) => e.node.inspections.edges.length <= 2)],
    ['violations are lists of codes', ok(r) && r.data.facilities.edges.every((e) => e.node.inspections.edges.every((i) => Array.isArray(i.node.violations) && i.node.violations.every((v) => typeof v.code === 'string')))],
  ],
  Q30: (c, [r]) => [['null, no error', ok(r) && r.data.facility === null]],
  Q31: (c, [r]) => {
    const i = ok(r) && r.data.inspection;
    const vs = i ? i.violations : [];
    return [
      ['the id round-trips and the date is a date', !!i && i.id === c.inspectionId && isDate(i.inspectionDate)],
      ['score is 0-100 and the report url is set', !!i && isInt(i.score) && i.score >= 0 && i.score <= 100 && typeof i.reportUrl === 'string' && i.reportUrl.length > 0],
      ['the inspection has violations with prefixed ids', vs.length > 0 && vs.every((v) => v.id.indexOf(`${c.inspectionId}:`) === 0)],
      ['violation fields are typed', vs.every((v) => typeof v.code === 'string' && isInt(v.points) && v.points >= 0 && typeof v.correctedOnSite === 'boolean' && typeof v.repeat === 'boolean' && typeof v.notes === 'string')],
      ['violation points are at most 100 in total', sum(vs.map((v) => v.points)) <= 100],
    ];
  },
  Q32: (c, [r]) => [['the facility is the one we came from', ok(r) && r.data.inspection.facility.id === c.facilityId && !!r.data.inspection.facility.name]],
  Q33: (c, [r]) => {
    const f = ok(r) && r.data.facility;
    const latest = f && f.inspections.nodes[0];
    return [['facility score and date equal its newest inspection', !!f && !!latest && f.lastInspectionScore === latest.score && f.lastInspectionDate === latest.inspectionDate]];
  },
  Q34: (c, [r]) => [['null, no error', ok(r) && r.data.inspection === null]],
  Q35: (c, [r]) => {
    const runs = ok(r) && r.data.syncRuns;
    const status = ['running', 'ok', 'failed', 'interrupted'];
    return [
      ['1 to 3 runs', !!runs && runs.length >= 1 && runs.length <= 3],
      ['newest first, with a valid status', !!runs && runs.every((x, i) => status.indexOf(x.status) !== -1 && (i === 0 || runs[i - 1].startedAt >= x.startedAt))],
    ];
  },
  Q36: (c, [r]) => [['runs of that county only', ok(r) && r.data.syncRuns.length >= 1 && r.data.syncRuns.every((x) => x.county === c.county)]],
  Q37: (c, [r]) => [
    ['only successful runs', ok(r) && r.data.syncRuns.length >= 1 && r.data.syncRuns.every((x) => x.status === 'ok')],
    ['result carries the counters', ok(r) && r.data.syncRuns.every((x) => x.result && isInt(x.result.facilitiesSeen) && isInt(x.result.inspectionsUpserted) && x.result.county === x.county)],
  ],
  Q38: (c, [r]) => [
    ['both filters return lists', ok(r) && Array.isArray(r.data.failed) && Array.isArray(r.data.interrupted)],
    ['a failed run explains itself', ok(r) && r.data.failed.every((x) => typeof x.error === 'string' && x.error.length > 0)],
  ],
  Q39: (c, [r]) => {
    const s = ok(r) && r.data.syncStatus;
    return [
      ['lastSuccessAt is a past timestamp', !!s && isTime(s.lastSuccessAt) && Date.parse(s.lastSuccessAt) <= Date.now()],
      ['running is a list and lastRuns holds 1-2 runs', !!s && Array.isArray(s.running) && s.lastRuns.length >= 1 && s.lastRuns.length <= 2],
    ];
  },
  Q40: (c, [r]) => [['BAD_USER_INPUT, no data', badInput(r)]],
  Q41: (c, [r]) => [['BAD_USER_INPUT, no data', badInput(r)]],
  Q42: (c, [r]) => [['BAD_USER_INPUT (Invalid cursor), no data', badInput(r) && /cursor/i.test(r.errors[0].message)]],
  Q43: (c, [r]) => [['BAD_USER_INPUT, no data', badInput(r)]],
  Q44: (c, [r]) => [['BAD_USER_INPUT, no data', badInput(r)]],
  Q45: (c, [r]) => [['BAD_USER_INPUT, no data', badInput(r)]],
  Q46: (c, [r]) => [['HTTP 400 GRAPHQL_VALIDATION_FAILED', r.status === 400 && r.code === 'GRAPHQL_VALIDATION_FAILED']],
  Q47: (c, [r]) => [['HTTP 400 QUERY_TOO_DEEP', r.status === 400 && r.code === 'QUERY_TOO_DEEP']],
  Q48: (c, [r]) => [['HTTP 400 QUERY_TOO_COMPLEX', r.status === 400 && r.code === 'QUERY_TOO_COMPLEX']],
  Q49: (c, [r]) => [['a mutation is rejected and returns no data', !!r.errors && !r.data]],
};

// ---------------------------------------------------------------- running a catalog entry
function runSteps(entry, ctx) {
  const results = [];
  let prev;
  for (const step of entry.steps) {
    if (step.walk) {
      const pages = [];
      let after = null;
      for (let i = 0; i < 40; i++) {
        const r = gql(step.query(ctx), Object.assign({}, step.vars(ctx), { after }), step.operationName);
        pages.push(r);
        if (!ok(r) || !r.data.facilities.pageInfo.hasNextPage) break;
        after = r.data.facilities.pageInfo.endCursor;
      }
      results.push(pages);
    } else {
      const r = gql(step.query(ctx), step.vars ? step.vars(ctx, prev) : undefined, step.operationName);
      results.push(r);
      prev = r.data;
    }
  }
  return results;
}

export default function (ctx) {
  group('H health endpoints', () => {
    const live = http.get(`${BASE_URL}/health/liveness`, { tags: { name: 'liveness' } });
    const ready = http.get(`${BASE_URL}/health/readiness`, { tags: { name: 'readiness' } });
    check(live, { 'liveness is 200': (r) => r.status === 200 });
    check(ready, { 'readiness is 200 and UP': (r) => r.status === 200 && r.json('status') === 'UP' });
  });

  for (const entry of catalog) {
    group(`${entry.id} ${entry.title}`, () => {
      let pairs;
      try {
        pairs = A[entry.id](ctx, runSteps(entry, ctx));
      } catch (e) {
        console.error(`${entry.id}: ${e}`);
        pairs = [[`ran without throwing (${e})`, false]];
      }
      for (const [label, passed] of pairs) check(passed, { [label]: (v) => v === true });
    });
  }
}
