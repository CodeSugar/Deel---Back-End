const express = require('express');
const bodyParser = require('body-parser');
const {sequelize} = require('./model')
const {getProfile} = require('./middleware/getProfile')
const { Op } = require("sequelize");
const app = express();

//Ajv for validate input whitout middleware
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const ajv = new Ajv();
addFormats(ajv);

//Initialize app Settings and parser
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * Get contract by id using current user logged in
 * @returns Contract
 */
app.get('/contracts/:id(\\d+)',getProfile ,async (req, res) =>{
    const {Contract} = req.app.get('models')
    const {id} = req.params
    const contract = await Contract.findOne({where: 
        [
            {id},
            {[Op.or]:{
                "ContractorId" : req.profile.id,
                "ClientId" : req.profile.id
            }}
        ]})
    if(!contract) return res.status(404).end()
    res.json(contract)
})

/**
 * Get all Contracts of current user logged in
 * @returns Contracts
 */
app.get('/contracts',getProfile ,async (req, res) =>{
    const {Contract} = req.app.get('models')
    const contracts = await Contract.findAll({where: 
        [
            {[Op.or]:{
                "ContractorId" : req.profile.id,
                "ClientId" : req.profile.id
            }},
            {[Op.not]:{
                "status" : "terminated"
            }}
        ]})
    if(!contracts) return res.status(404).end()
    res.json(contracts)
})

/**
 * Get jobs unpaid of current user logged in
 * @returns Jobs
 */
app.get('/jobs/unpaid',getProfile ,async (req, res) =>{
    const {Job,Contract} = req.app.get('models')
    const jobs = await Job.findAll({ 
        include: { 
            model: Contract,
            where:{
                [Op.or]:{
                    "ContractorId" : req.profile.id,
                    "ClientId" : req.profile.id
                }
            }
        },
        where: [
            {"paid":{
                [Op.not]: true
            }}
        ]
    })
    if(!jobs) return res.status(404).end()
    res.json(jobs)
})

/**
 * Pay for Job with id if not paid before, current user is owner and enough balance
 * @returns status of transaction
 */
app.post('/jobs/:job_id(\\d+)/pay',getProfile ,async (req, res) =>{
    const {Job,Contract,Profile} = req.app.get('models')
    const {job_id} = req.params
    await sequelize.transaction(async (t) => {
        const job = await Job.findOne({ 
            transaction: t,
            include: { 
                model: Contract,
                where: {
                    "ClientId" : req.profile.id  // Filer Jobs for current user
                },
                include : [
                    {model: Profile, as: 'Contractor',},{model: Profile,  as: 'Client'}
                ]
            },
            where: [
                {"id":job_id},
                {"paid":{
                    [Op.not]: true   // Filter if Job is already paid
                }}
            ]
        })

        if(!job) return res.status(404).end("Job not found or valid")

        const contractor = job.Contract.Contractor
        const client = job.Contract.Client
        if( client.balance < job.price)
            return res.status(403).end("Insufficient Balance")
        
        await client.decrement('balance', { by: job.price , transaction: t})
        await contractor.increment('balance', { by: job.price , transaction: t})
        await job.update({ paid: true, paymentDate: sequelize.literal('CURRENT_TIMESTAMP')},{ transaction: t})
        return res.status(200).end("Job Paid")
        
    });
    return res.status(500)
})

/**
 * deposit balance to userId 
 * Fix! Anyone can add balance
 * @returns status of deposit
 */
app.post('/balances/deposit/:userId(\\d+)',getProfile ,async (req, res) =>{
    //Validation of deposit
    const schemaQuery = {
        type: 'object',
        properties: {
            balance: { "type": "integer" },
        },
        required: ['balance'],
        additionalProperties: true
    }
    try{
        console.log(req.body)
        const valid = ajv.validate(schemaQuery, req.body);
        if( ! valid ) return res.status(400).end()
    }catch(error){
        return res.status(400).end()
    }
    
    const {balance} = req.body;

    const {Job,Contract,Profile} = req.app.get('models')
    const {userId} = req.params
    await sequelize.transaction(async (t) => {
        const user = await Profile.findOne({ 
            transaction: t,
            where: [
                {"id":userId}
            ]
        })

        const jobsAmount = await Job.sum("price",{ 
            transaction: t,
            include: { 
                model: Contract,
                where: {
                    "ClientId" : userId  // Filer Jobs for userId
                }
            },
            where: [
                {"paid":{
                    [Op.not]: true   // Filter if Job is already paid
                }}
            ]
        })

        if( (jobsAmount*0.25) < balance)
            return res.status(403).end("Can't deposit more than 25% of total jobs to pay (" + (jobsAmount*0.25)  + ")")

        await user.increment('balance', { by: balance , transaction: t})
        
        return res.status(200).end("Balance increased")
        
    });
    return res.status(500)
})

/**
 * Get the best profession that earned more in the time range
 * !Fix anyone can run it, maybe add new rool admin? 
 * @returns Profession
 */
app.get('/admin/best-profession' ,async (req, res) =>{
    //Validation of dates
    const schemaQuery = {
        type: 'object',
        properties: {
            start: { "type": "string", "format": "date-time" },
            end: { "type": "string", "format": "date-time" }
        },
        required: ['start', 'end'],
        additionalProperties: true
    }

    const valid = ajv.validate(schemaQuery, req.query);
    if( ! valid ) return res.status(400).end()

    const {start,end}  = req.query;
    const {Job,Contract,Profile} = req.app.get('models')

    const result = await Job.findOne({ 
        where: [
            {"paymentDate":{
                [Op.between] : [start,end]
            }}
        ],
        attributes: [
            [sequelize.fn('SUM', sequelize.col('price')), 'Total'],
            [sequelize.col('Contract.Contractor.profession'), 'Profession']
        ],
        include: { 
            model: Contract,
            include: { 
                model: Profile,
                as : "Contractor",
                attributes: ["profession"]  
            },
            attributes: []
        },
        group: sequelize.col('Contract.Contractor.profession') ,
        order: [
            [ "Total", 'DESC' ]
        ]
    })

    if(!result) return res.status(404).end()

    const profession = result.dataValues.Profession;
    return res.json({profession});
})

/**
 * Get the best client that payed more in the time range
 * !Fix anyone can run it, maybe add new rool admin? 
 * @returns Clients
 */
app.get('/admin/best-clients' ,async (req, res) =>{
    //Validation of dates
    const schemaQuery = {
        type: 'object',
        properties: {
            start: { "type": "string", "format": "date-time" },
            end: { "type": "string", "format": "date-time" },
            limit: { "type" : "string"}
        },
        required: ['start', 'end'],
        additionalProperties: true
    }

    const valid = ajv.validate(schemaQuery, req.query);
    if( ! valid ) return res.status(400).end()

    let {start,end,limit}  = req.query;
    if(!limit) limit = 2;
    const {Job,Contract,Profile} = req.app.get('models')

    const result = await Job.findAll({ 
        where: [
            {"paymentDate":{
                [Op.between] : [start,end]
            }}
        ],
        attributes: [
            [sequelize.col("Contract.Client.id"), 'id'],
            [sequelize.literal("firstName || ' ' || lastName"), "fullName"],
            [sequelize.fn('SUM', sequelize.col('price')), 'paid']
        ],
        include: { 
            model: Contract,
            include: { 
                model: Profile,
                as : "Client",
                attributes: []  
            },
            attributes: []
        },
        group: sequelize.col('Contract.Client.id') ,
        order: [
            [ "paid", 'DESC' ]
        ],
        limit: limit
    })

    if(!result) return res.status(404).end()

    return res.json(result);
})
module.exports = app;
