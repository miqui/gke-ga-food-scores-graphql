// Catalog of example queries. Single source of truth for two consumers:
//   - k6/api-examples.js runs every query against a live API and asserts on the results;
//   - k6/render-readme.mjs renders them into the "How to use this API" section of README.md.
//
// No k6 imports here, so Node can load it too. A query is `steps[i].query(ctx)`; `vars(ctx, prev)`
// builds the variables (prev = `data` of the previous step). The README renders with SAMPLE_CTX
// (and `sampleVars` when a step's variables only exist at run time, e.g. a cursor).
//
// ctx fields (discovered from the live API by k6 `setup()`, see api-examples.js):
//   county        a county with plenty of facilities       city         its most common city
//   smallCounty   a county with 1..100 facilities (or null)  smallTotal   its facility count
//   otherCounty   a second county (for aliases)
//   nameTerm      a word from a facility name              addrTerm     a word from an address
//   facilityId    a facility with 3+ inspections           inspectionId its latest inspection (has violations)

export const SAMPLE_CTX = {
  county: 'BRYAN',
  city: 'RICHMOND HILL',
  smallCounty: 'APPLING',
  otherCounty: 'APPLING',
  smallTotal: 80,
  nameTerm: 'pizza',
  addrTerm: 'hwy',
  facilityId: 'OTQ5MDk0Mw==',
  inspectionId: '99524328',
};

const s = (v) => JSON.stringify(v); // GraphQL string literal

const FACILITY_CARD = 'id name city county lastInspectionScore lastInspectionDate';

export const catalog = [
  // ---------------------------------------------------------------- Getting started
  {
    id: 'Q1',
    group: 'Getting started',
    title: 'Ping',
    note: 'The cheapest valid request: the type name of the root.',
    steps: [{ query: () => '{ __typename }' }],
  },
  {
    id: 'Q2',
    group: 'Getting started',
    title: 'List the counties',
    note: 'All 159 Georgia counties, upper case: the exact values the `county` filter accepts.',
    steps: [{ query: () => '{ counties }' }],
  },
  {
    id: 'Q3',
    group: 'Getting started',
    title: 'Discover a type with introspection',
    note: 'What can I ask a `Facility`? (Introspection is on in the dev cluster.)',
    steps: [{ query: () => '{ __type(name: "Facility") { name fields { name type { kind name ofType { name } } } } }' }],
  },

  // ---------------------------------------------------------------- Listing facilities
  {
    id: 'Q4',
    group: 'Listing facilities',
    title: 'First page of a county',
    note: 'Newest last inspection first. `totalCount` runs a `COUNT(*)`, so only ask for it when you need it.',
    steps: [
      {
        query: (c) => `{ facilities(county: ${s(c.county)}, first: 5) {
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes { ${FACILITY_CARD} }
} }`,
      },
    ],
  },
  {
    id: 'Q5',
    group: 'Listing facilities',
    title: 'Edges and cursors',
    note: 'Use `edges { cursor node { ... } }` when you want a cursor for every row, not just the last one.',
    steps: [
      {
        query: (c) => `{ facilities(county: ${s(c.county)}, first: 3) {
  edges { cursor node { id name } }
  pageInfo { startCursor endCursor hasNextPage hasPreviousPage }
} }`,
      },
    ],
  },
  {
    id: 'Q6',
    group: 'Listing facilities',
    title: 'Filter by county (case-insensitive)',
    note: '`county` is an exact match, ignoring case, so `bryan`, `Bryan` and `BRYAN` are the same.',
    steps: [{ query: (c) => `{ facilities(county: ${s(c.county.toLowerCase())}, first: 3) { totalCount nodes { name county } } }` }],
  },
  {
    id: 'Q7',
    group: 'Listing facilities',
    title: 'Filter by city',
    note: '`city` is an exact match, ignoring case.',
    steps: [{ query: (c) => `{ facilities(city: ${s(c.city.toLowerCase())}, first: 3) { totalCount nodes { name city } } }` }],
  },
  {
    id: 'Q8',
    group: 'Listing facilities',
    title: 'Search by name',
    note: '`q` is a case-insensitive substring of the name, address or city (max 100 characters).',
    steps: [{ query: (c) => `{ facilities(county: ${s(c.county)}, q: ${s(c.nameTerm)}, first: 5) { totalCount nodes { name address city lastInspectionScore } } }` }],
  },
  {
    id: 'Q9',
    group: 'Listing facilities',
    title: 'Search by address',
    note: 'The same `q` also matches addresses. Addresses are stored with a `\\r\\n` between street and city.',
    steps: [{ query: (c) => `{ facilities(county: ${s(c.county)}, q: ${s(c.addrTerm)}, first: 5) { totalCount nodes { name address city } } }` }],
  },
  {
    id: 'Q10',
    group: 'Listing facilities',
    title: 'Only facilities with a perfect score',
    note: '`minScore` keeps facilities whose latest score is `>=` the value (0-100). Facilities without a score are excluded.',
    steps: [{ query: (c) => `{ facilities(county: ${s(c.county)}, minScore: 100, first: 5) { totalCount nodes { name lastInspectionScore } } }` }],
  },
  {
    id: 'Q11',
    group: 'Listing facilities',
    title: 'County plus minimum score',
    steps: [{ query: (c) => `{ facilities(county: ${s(c.county)}, minScore: 95, first: 5) { totalCount nodes { name county lastInspectionScore } } }` }],
  },
  {
    id: 'Q12',
    group: 'Listing facilities',
    title: 'Combine every filter',
    note: 'Filters combine with AND.',
    steps: [
      {
        query: (c) => `{ facilities(city: ${s(c.city)}, q: ${s(c.nameTerm)}, minScore: 90, first: 5) {
  totalCount
  nodes { name address city lastInspectionScore }
} }`,
      },
    ],
  },
  {
    id: 'Q13',
    group: 'Listing facilities',
    title: 'Order: newest inspection first',
    note: 'Results are sorted by `lastInspectionDate` descending; facilities never inspected come last.',
    steps: [{ query: (c) => `{ facilities(county: ${s(c.county)}, first: 10) { nodes { name lastInspectionDate } } }` }],
  },
  {
    id: 'Q14',
    group: 'Listing facilities',
    title: 'Next page with a cursor',
    note: 'Pagination is forward-only. Pass the previous page\'s `pageInfo.endCursor` as `after`.',
    steps: [
      {
        query: (c) => `{ facilities(county: ${s(c.county)}, first: 3) { pageInfo { endCursor } nodes { id name lastInspectionDate } } }`,
      },
      {
        query: () => `query Next($county: String, $after: String) {
  facilities(county: $county, first: 3, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id name county lastInspectionDate }
  }
}`,
        vars: (c, prev) => ({ county: c.county, after: prev.facilities.pageInfo.endCursor }),
        sampleVars: (c) => ({ county: c.county, after: '<endCursor from the previous page>' }),
      },
    ],
  },
  {
    id: 'Q15',
    group: 'Listing facilities',
    title: 'Walk every page of a small county',
    note: 'Repeat the request while `hasNextPage` is true. The ids collected equal `totalCount`.',
    steps: [
      {
        query: () => `query Page($county: String, $after: String) {
  facilities(county: $county, first: 25, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { id }
  }
}`,
        vars: (c) => ({ county: c.smallCounty, after: null }),
        walk: true, // k6 repeats this step, feeding endCursor back as `after`
      },
    ],
  },
  {
    id: 'Q16',
    group: 'Listing facilities',
    title: 'Count only',
    note: 'Selecting only `totalCount` is the cheapest way to size a result set.',
    steps: [{ query: (c) => `{ facilities(county: ${s(c.county)}, minScore: 90) { totalCount } }` }],
  },
  {
    id: 'Q17',
    group: 'Listing facilities',
    title: 'No matches is an empty page, not an error',
    steps: [{ query: () => '{ facilities(q: "zzz-no-such-place") { totalCount nodes { id } pageInfo { hasNextPage endCursor } } }' }],
  },
  {
    id: 'Q18',
    group: 'Listing facilities',
    title: 'Facilities whose history is still syncing',
    note: '`historyPending` is true while a facility\'s inspection history has not been fully synced yet.',
    steps: [{ query: (c) => `{ facilities(county: ${s(c.county)}, first: 5) { nodes { name historyPending updatedAt } } }` }],
  },

  // ---------------------------------------------------------------- GraphQL features
  {
    id: 'Q19',
    group: 'GraphQL features',
    title: 'Aliases: two counties in one request',
    steps: [
      {
        query: (c) => `{
  first: facilities(county: ${s(c.county)}, first: 1) { totalCount nodes { name } }
  second: facilities(county: ${s(c.otherCounty)}, first: 1) { totalCount nodes { name } }
}`,
      },
    ],
  },
  {
    id: 'Q20',
    group: 'GraphQL features',
    title: 'Fragments',
    steps: [
      {
        query: (c) => `{
  facilities(county: ${s(c.county)}, first: 2) { nodes { ...Card } }
}
fragment Card on Facility { name city lastInspectionScore lastInspectionDate }`,
      },
    ],
  },
  {
    id: 'Q21',
    group: 'GraphQL features',
    title: 'Variables with default values',
    steps: [
      {
        query: (c) => `query Browse($county: String = ${s(c.county)}, $n: Int = 3) {
  facilities(county: $county, first: $n) { nodes { name } }
}`,
        sampleVars: () => undefined,
      },
    ],
  },
  {
    id: 'Q22',
    group: 'GraphQL features',
    title: '@include and @skip',
    steps: [
      {
        query: (c) => `query Card($full: Boolean!) {
  facilities(county: ${s(c.county)}, first: 2) {
    nodes { name address @include(if: $full) phone @skip(if: $full) }
  }
}`,
        vars: () => ({ full: true }),
      },
    ],
  },
  {
    id: 'Q23',
    group: 'GraphQL features',
    title: 'Several operations in one document',
    note: 'Send `operationName` to pick one; without it the server answers `OPERATION_RESOLUTION_FAILURE` (HTTP 400).',
    steps: [
      {
        query: () => 'query Names { counties }\nquery Ping { __typename }',
        operationName: 'Ping',
      },
    ],
  },
  {
    id: 'Q24',
    group: 'GraphQL features',
    title: 'Several root fields in one round trip',
    steps: [
      {
        query: (c) => `{
  counties
  facility(id: ${s(c.facilityId)}) { name }
  inspection(id: ${s(c.inspectionId)}) { inspectionDate score }
}`,
      },
    ],
  },

  // ---------------------------------------------------------------- Facility and its inspections
  {
    id: 'Q25',
    group: 'Facility and inspections',
    title: 'One facility by id',
    note: 'The id is the portal facility id (take it from any `facilities` result). Unknown ids return `null`.',
    steps: [{ query: (c) => `{ facility(id: ${s(c.facilityId)}) { id name address city county permitType permitNumber phone lastInspectionScore lastInspectionDate historyPending updatedAt } }` }],
  },
  {
    id: 'Q26',
    group: 'Facility and inspections',
    title: 'A facility with its latest inspections',
    steps: [
      {
        query: (c) => `{ facility(id: ${s(c.facilityId)}) {
  name
  inspections(first: 2) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { id inspectionDate purpose score inspector }
  }
} }`,
      },
    ],
  },
  {
    id: 'Q27',
    group: 'Facility and inspections',
    title: 'Page through a facility\'s inspections',
    note: 'Inspections are newest first and paginate like facilities.',
    steps: [
      {
        query: (c) => `{ facility(id: ${s(c.facilityId)}) { inspections(first: 1) { pageInfo { endCursor } nodes { id inspectionDate } } } }`,
      },
      {
        query: () => `query More($id: ID!, $after: String) {
  facility(id: $id) { inspections(first: 1, after: $after) { pageInfo { hasNextPage } nodes { id inspectionDate } } }
}`,
        vars: (c, prev) => ({ id: c.facilityId, after: prev.facility.inspections.pageInfo.endCursor }),
        sampleVars: (c) => ({ id: c.facilityId, after: '<endCursor from the previous page>' }),
      },
    ],
  },
  {
    id: 'Q28',
    group: 'Facility and inspections',
    title: 'How many inspections does a facility have?',
    steps: [{ query: (c) => `{ facility(id: ${s(c.facilityId)}) { name inspections(first: 1) { totalCount } } }` }],
  },
  {
    id: 'Q29',
    group: 'Facility and inspections',
    title: 'The deepest allowed query: facility to violation',
    note: 'Depth 8 is the limit: `facilities > edges > node > inspections > edges > node > violations > code`. `minScore: 0` keeps only facilities that have been scored, so each has inspections.',
    steps: [
      {
        query: (c) => `{ facilities(county: ${s(c.county)}, minScore: 0, first: 2) {
  edges { node { name inspections(first: 2) { edges { node { inspectionDate violations { code } } } } } }
} }`,
      },
    ],
  },
  {
    id: 'Q30',
    group: 'Facility and inspections',
    title: 'Unknown facility returns null',
    steps: [{ query: () => '{ facility(id: "does-not-exist") { id name } }' }],
  },

  // ---------------------------------------------------------------- Inspections and violations
  {
    id: 'Q31',
    group: 'Inspections and violations',
    title: 'One inspection with its violations',
    note: '`violations` is a plain list; `points`, `correctedOnSite` and `repeat` are as reported by the portal. Note the score is not always 100 minus the points.',
    steps: [
      {
        query: (c) => `{ inspection(id: ${s(c.inspectionId)}) {
  id inspectionDate purpose score inspector reportUrl
  violations { id code ruleCitation points correctedOnSite repeat notes }
} }`,
      },
    ],
  },
  {
    id: 'Q32',
    group: 'Inspections and violations',
    title: 'From an inspection back to its facility',
    steps: [{ query: (c) => `{ inspection(id: ${s(c.inspectionId)}) { score facility { id name city } } }` }],
  },
  {
    id: 'Q33',
    group: 'Inspections and violations',
    title: 'Latest score matches the facility\'s score',
    note: '`lastInspectionScore` on the facility is the score of its newest inspection.',
    steps: [
      {
        query: (c) => `{ facility(id: ${s(c.facilityId)}) {
  lastInspectionScore
  lastInspectionDate
  inspections(first: 1) { nodes { score inspectionDate } }
} }`,
      },
    ],
  },
  {
    id: 'Q34',
    group: 'Inspections and violations',
    title: 'Unknown inspection returns null',
    steps: [{ query: () => '{ inspection(id: "does-not-exist") { id } }' }],
  },

  // ---------------------------------------------------------------- Data freshness
  {
    id: 'Q35',
    group: 'Data freshness (sync)',
    title: 'Most recent sync runs',
    note: 'One run per county per sync, newest first. `limit` is 1-50.',
    steps: [{ query: () => '{ syncRuns(limit: 3) { id county status startedAt finishedAt } }' }],
  },
  {
    id: 'Q36',
    group: 'Data freshness (sync)',
    title: 'Sync runs of one county',
    steps: [{ query: (c) => `{ syncRuns(county: ${s(c.county)}, limit: 3) { id county status finishedAt } }` }],
  },
  {
    id: 'Q37',
    group: 'Data freshness (sync)',
    title: 'Successful runs with their counters',
    note: '`result` is JSON: pages walked, facilities seen/upserted, inspections and violations upserted, new watermark.',
    steps: [{ query: () => '{ syncRuns(status: ok, limit: 2) { county status result } }' }],
  },
  {
    id: 'Q38',
    group: 'Data freshness (sync)',
    title: 'Failed or interrupted runs',
    note: '`status` is an enum: `running`, `ok`, `failed`, `interrupted`. An empty list is the good answer.',
    steps: [{ query: () => '{ failed: syncRuns(status: failed, limit: 5) { county error } interrupted: syncRuns(status: interrupted, limit: 5) { county } }' }],
  },
  {
    id: 'Q39',
    group: 'Data freshness (sync)',
    title: 'How fresh is the data?',
    note: '`running` lists syncs in progress; `lastSuccessAt` is the most recent successful run of any county.',
    steps: [{ query: () => '{ syncStatus { lastSuccessAt running { county startedAt } lastRuns(limit: 2) { county status } } }' }],
  },

  // ---------------------------------------------------------------- Errors and limits
  {
    id: 'Q40',
    group: 'Errors and limits',
    title: 'Page size 0 is rejected',
    note: '`first` must be 1-100. Out-of-range values are rejected (`BAD_USER_INPUT`), not clamped.',
    steps: [{ query: () => '{ facilities(first: 0) { totalCount } }' }],
  },
  {
    id: 'Q41',
    group: 'Errors and limits',
    title: 'Page size 101 is rejected',
    steps: [{ query: () => '{ facilities(first: 101) { totalCount } }' }],
  },
  {
    id: 'Q42',
    group: 'Errors and limits',
    title: 'Invalid cursor',
    steps: [{ query: () => '{ facilities(after: "not-a-cursor") { totalCount } }' }],
  },
  {
    id: 'Q43',
    group: 'Errors and limits',
    title: 'Score out of range',
    steps: [{ query: () => '{ facilities(minScore: 150) { totalCount } }' }],
  },
  {
    id: 'Q44',
    group: 'Errors and limits',
    title: 'Search text too long',
    steps: [{ query: () => `{ facilities(q: ${s('a'.repeat(101))}) { totalCount } }` }],
  },
  {
    id: 'Q45',
    group: 'Errors and limits',
    title: 'Sync run limit out of range',
    steps: [{ query: () => '{ syncRuns(limit: 0) { id } }' }],
  },
  {
    id: 'Q46',
    group: 'Errors and limits',
    title: 'Unknown field (HTTP 400)',
    note: 'Validation errors come back with HTTP 400 and `GRAPHQL_VALIDATION_FAILED`.',
    steps: [{ query: () => '{ facilities(first: 1) { nodes { nope } } }' }],
  },
  {
    id: 'Q47',
    group: 'Errors and limits',
    title: 'Too deep (HTTP 400)',
    note: 'Depth limit 8. This query reaches 11 and is rejected with `QUERY_TOO_DEEP`.',
    steps: [
      {
        query: () => `{ facilities(first: 1) { edges { node { inspections(first: 1) { edges { node {
  facility { inspections(first: 1) { edges { node { id } } } }
} } } } } } }`,
      },
    ],
  },
  {
    id: 'Q48',
    group: 'Errors and limits',
    title: 'Too expensive (HTTP 400)',
    note: 'Cost limit 10,000 (`first` multiplies the cost of everything below it). Rejected with `QUERY_TOO_COMPLEX`; ask for smaller pages.',
    steps: [{ query: () => '{ facilities(first: 100) { nodes { inspections(first: 100) { nodes { violations { code points notes } } } } } }' }],
  },
  {
    id: 'Q49',
    group: 'Errors and limits',
    title: 'There are no mutations',
    note: 'The API is read-only. The schema has no `Mutation` or `Subscription` type (the first request needs introspection), and a mutation is rejected with HTTP 400 and `OPERATION_NOT_SUPPORTED`.',
    steps: [
      { query: () => '{ __schema { mutationType { name } subscriptionType { name } } }' },
      { query: () => 'mutation { anything }' },
    ],
  },
];
