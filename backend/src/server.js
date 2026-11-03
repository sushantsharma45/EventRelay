import "dotenv/config";
import express from "express";

const app = express();
const PORT = process.env.PORT;

app.use(express.json());

app.get("/health", (req, res) => {
    res.status(200).json({
        status : "success",
        service : "EventRelay"
    })
})

app.post("/api/v1/events", (req, res) => {
    const event = req.body;
    res.status(202).json({
        status : "success",
        message : "Event received successfully",
        event : event
    })
})

app.listen(PORT, () => {
    console.log(`EventRelay service is running on port ${PORT}`)
})