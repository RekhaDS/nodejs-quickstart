import express from 'express'
import bcrypt from 'bcryptjs'
import { v4 } from 'uuid'
import cors from 'cors'

import { couchbase, cluster, profileCollection } from '../db/connection'

const app = express()

var allowlist = ['https://gitpod.io', 'http://localhost:3000']
var corsOptionsDelegate = function (req, callback) {
  var corsOptions;
  if (allowlist.indexOf(req.header('Origin')) !== -1) {
    corsOptions = { origin: true } // reflect (enable) the requested origin in the CORS response
  } else {
    corsOptions = { origin: false } // disable CORS for this request
  }
  callback(null, corsOptions) // callback expects two parameters: error and options
}

app.options('*', cors())
// app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

import swaggerUi from 'swagger-ui-express'
import YAML from 'yamljs'
const swaggerDocument = YAML.load('./swagger.yaml')
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument))
app.get('/', function (req, res) {
  res.send('<a href="/api-docs">Profile Store Docs</a>')
})

const ensureProfileIndex = async() => {
  try {
    const query = `
      CREATE PRIMARY INDEX ON default:${process.env.CB_BUCKET}._default.profile
    `
    const result = await cluster.query(query)
    console.log(`Index Creation: ${result.meta.status}`)
  } catch (err) {
    if (err instanceof couchbase.IndexExistsError) {
      console.info('Index Creation: Index Already Exists')
    } else {
      console.error(err)
    }
  }
}

app.post("/profile", cors(corsOptionsDelegate), async (req, res) => {
  if (!req.body.email || !req.body.pass) {
    return res.status(400).send({ "message": `${!req.body.email ? 'email ' : ''}${
      (!req.body.email && !req.body.pass) 
        ? 'and pass are required' : (req.body.email && !req.body.pass) 
          ? 'pass is required' : 'is required'
    }`})
  }

  const id = v4()
  const profile = { pid: id, ...req.body, pass: bcrypt.hashSync(req.body.pass, 10) }
  await profileCollection.insert(id, profile)
    .then((result) => res.send({ ...profile, ...result }))
    .catch((e) => res.status(500).send({
      "message": `Profile Insert Failed: ${e.message}`
    }))
})

app.get("/profile/:pid", cors(corsOptionsDelegate), async (req, res) => {
  try {
    await profileCollection.get(req.params.pid)
      .then((result) => res.send(result.value))
      .catch((error) => res.status(500).send({
        "message": `KV Operation Failed: ${error.message}`
      }))
  } catch (error) {
    console.error(error)
  }
})

app.put("/profile/:pid", cors(corsOptionsDelegate), async (req, res) => {
  try {
    await profileCollection.get(req.params.pid)
      .then(async (result) => {
        /* Create a New Document with new values, 
          if they are not passed from request, use existing values */
        const newDoc = {
          pid: result.value.pid,
          firstName: req.body.firstName ? req.body.firstName : result.value.firstName,
          lastName: req.body.lastName ? req.body.lastName : result.value.lastName,
          email: req.body.email ? req.body.email : result.value.email,
          pass: req.body.pass ? bcrypt.hashSync(req.body.pass, 10) : result.value.pass,
        }
        /* Persist updates with new doc */
        await profileCollection.upsert(req.params.pid, newDoc)
          .then((result) => res.send({ ...newDoc, ...result }))
          .catch((e) => res.status(500).send(e))
      })
      .catch((e) => res.status(500).send({
        "message": `Profile Not Found, cannot update: ${e.message}`
      }))
  } catch (e) {
    console.error(e)
  }
})

app.delete("/profile/:pid", cors(corsOptionsDelegate), async (req, res) => {
  try {
    await profileCollection.remove(req.params.pid)
      .then((result) => res.send(result.value))
      .catch((error) => res.status(500).send({
        "message": `Profile Not Found, cannot delete: ${error.message}`
      }))
  } catch (e) {
    console.error(e)
  }
})

app.get("/profiles", cors(corsOptionsDelegate), async (req, res) => {
  try {
    const options = {
      parameters: {
        SKIP: Number(req.query.skip || 0),
        LIMIT: Number(req.query.limit || 5),
        SEARCH: `%${req.query.search.toLowerCase()}%`
      }
    }
    const query = `
      SELECT p.*
      FROM ${process.env.CB_BUCKET}._default.profile p
      WHERE lower(p.firstName) LIKE $SEARCH OR lower(p.lastName) LIKE $SEARCH
      LIMIT $LIMIT OFFSET $SKIP;
    `
    await cluster.query(query, options)
      .then((result) => res.send(result.rows))
      .catch((error) => res.status(500).send({
        "message": `Query failed: ${error.message}`
      }))
  } catch (e) {
    console.error(e)
  }
})

module.exports = { app, ensureProfileIndex }
