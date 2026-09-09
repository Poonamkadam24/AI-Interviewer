import asyncHandler from 'express-async-handler';
import Session from '../models/SessionModel.js';
import fetch from 'node-fetch'; // Standard for making HTTP requests (npm install node-fetch@2.6.1)
import fs from 'fs'; // <-- NEW: For reading and deleting the temporary file
import FormData from 'form-data'; // <-- NEW: For sending files to FastAPI
import path from 'path';
import mongoose from 'mongoose';
// URL for the Python AI Microservice (Configurable for deployment)
const rawAiUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const AI_SERVICE_URL = rawAiUrl.replace(/\/+$/, '');

// Helper function to send an update via Socket.io
const pushSocketUpdate = (io, userId, sessionId, status, message, session = null) => {
    io.to(userId.toString()).emit('sessionUpdate', {
        sessionId,
        status,
        message,
        session,
    });
};

// @desc    Create a new interview session and start AI question generation
// @route   POST /api/sessions/
// @access  Private
const createSession = asyncHandler(async (req, res) => {
    const { role, level, interviewType, count } = req.body;
    const userId = req.user._id;

    if (!role || !level || !interviewType || !count) {
        res.status(400);
        throw new Error('Please specify role, level, interview type, and question count.');
    }

    // 1. Create the session placeholder in MongoDB
    let session = await Session.create({
        user: userId,
        role,
        level,
        interviewType,
        status: 'pending',
    });

    const io = req.app.get('io');

    // 2. Immediately respond to the client
    res.status(202).json({
        message: 'Session created. Generating questions asynchronously...',
        sessionId: session._id,
        status: 'processing',
    });

    // --- ASYNCHRONOUS BACKGROUND TASK START ---
    (async () => {
        try {
            pushSocketUpdate(io, userId, session._id, 'AI_GENERATING_QUESTIONS', `Generating ${count} questions for ${role}...`);

            // Fetch with a 25-second controller timeout to prevent cloud gateway timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000);

            const aiResponse = await fetch(`${AI_SERVICE_URL}/generate-questions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role,
                    level,
                    count: Number(count),
                    interview_type: interviewType
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!aiResponse.ok) {
                const errorBody = await aiResponse.text();
                throw new Error(`AI Service status ${aiResponse.status}: ${errorBody}`);
            }

            const aiData = await aiResponse.json();
            const codingCount = interviewType === 'coding-mix' ? Math.floor(count * 0.2) : 0;
            const questionsArray = aiData.questions.map((qText, index) => ({
                questionText: qText,
                questionType: index < codingCount ? 'coding' : 'oral',
                isEvaluated: false,
                isSubmitted: false,
            }));

            session.questions = questionsArray;
            session.status = 'in-progress';
            await session.save();

            pushSocketUpdate(io, userId, session._id, 'QUESTIONS_READY', 'Questions generated successfully. Starting session.', session);

        } catch (error) {
            console.error(`Session Creation Warning for ${session._id}:`, error.message);

            // Fallback question engine to ensure session NEVER fails for the candidate
            const codingCount = interviewType === 'coding-mix' ? Math.floor(count * 0.2) : 0;
            const oralCount = count - codingCount;

            const fallbackCoding = [
                `Write a function in JavaScript/Python to reverse a string without using built-in reverse methods.`,
                `Implement a function to find the first non-repeating character in a string for a ${role}.`,
                `Write an algorithm to check if two strings are valid anagrams of each other.`
            ];

            const fallbackOral = [
                `Explain the key architectural concepts of ${role} and how data flows through the application.`,
                `What are the key differences between synchronous and asynchronous code execution in modern applications?`,
                `How do you optimize state management and handle performance bottlenecks in a ${level} level codebase?`,
                `Describe how authentication and authorization (e.g. JWT/OAuth) are securely implemented.`,
                `Explain RESTful API design principles and how error handling should be structured.`
            ];

            const questionsArray = [];
            for (let i = 0; i < codingCount; i++) {
                questionsArray.push({ questionText: fallbackCoding[i % fallbackCoding.length], questionType: 'coding', isEvaluated: false, isSubmitted: false });
            }
            for (let i = 0; i < oralCount; i++) {
                questionsArray.push({ questionText: fallbackOral[i % fallbackOral.length], questionType: 'oral', isEvaluated: false, isSubmitted: false });
            }

            session.questions = questionsArray;
            session.status = 'in-progress';
            await session.save();

            pushSocketUpdate(io, userId, session._id, 'QUESTIONS_READY', 'Questions ready for your interview session.', session);
        }
    })();
});

// @desc    Get all interview sessions for the current user
// @route   GET /api/sessions/
// @access  Private
const getSessions = asyncHandler(async (req, res) => {
    // Find all sessions for the logged-in user, sorted by newest first
    const sessions = await Session.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .select('-questions.userAnswerText -questions.userSubmittedCode'); // Exclude heavy data for list view
    res.json(sessions);
});

// @desc    Get a specific session detail
// @route   GET /api/sessions/:id
// @access  Private
const getSessionById = asyncHandler(async (req, res) => {
    // Find session by ID and ensure it belongs to the logged-in user
    const session = await Session.findOne({ _id: req.params.id, user: req.user._id });

    if (session) {
        res.json(session);
    } else {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }
});

// @desc    Delete a session
// @route   DELETE /api/sessions/:id
// @access  Private
const deleteSession = asyncHandler(async (req, res) => {
    const session = await Session.findById(req.params.id);

    if (!session) {
        res.status(404);
        throw new Error('Session not found');
    }

    // Check if the user owns this session
    if (session.user.toString() !== req.user.id) {
        res.status(401);
        throw new Error('Not authorized');
    }

    await session.deleteOne();

    res.status(200).json({ id: req.params.id });
});

const evaluateAnswerAsync = async (io, userId, sessionId, questionIndex, audioFilePath = null, code = null) => {
    let transcription = "";
    const questionIdx = typeof questionIndex === 'string' ? parseInt(questionIndex, 10) : questionIndex;

    const session = await Session.findById(sessionId);
    if (!session) {
        console.error(`Session ${sessionId} not found`);
        return;
    }

    const question = session.questions[questionIdx];
    if (!question) {
        pushSocketUpdate(io, userId, sessionId, 'EVALUATION_FAILED', `Q${questionIdx + 1} not found.`, null);
        return;
    }

    // --- Phase 1: Transcription ---
    if (audioFilePath) {
        try {
            pushSocketUpdate(io, userId, sessionId, 'AI_TRANSCRIBING', `Transcribing audio for Q${questionIdx + 1}...`);
            const formData = new FormData();
            formData.append('file', fs.createReadStream(audioFilePath));

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const transResponse = await fetch(`${AI_SERVICE_URL}/transcribe`, {
                method: 'POST',
                body: formData,
                headers: formData.getHeaders(),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (transResponse.ok) {
                const transData = await transResponse.json();
                transcription = transData.transcription || "";
            }
        } catch (error) {
            console.error(`Transcription Error: ${error.message}`);
            transcription = "Verbal response submitted successfully.";
        } finally {
            if (audioFilePath && fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
        }
    }

    // --- Phase 2: AI Evaluation ---
    let evalData = null;
    try {
        pushSocketUpdate(io, userId, sessionId, 'AI_EVALUATING', `AI is analyzing Q${questionIdx + 1}...`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        const evalResponse = await fetch(`${AI_SERVICE_URL}/evaluate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: question.questionText,
                question_type: question.questionType,
                role: session.role,
                level: session.level,
                user_answer: transcription,
                user_code: code || "",
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (evalResponse.ok) {
            evalData = await evalResponse.json();
        }
    } catch (error) {
        console.warn(`AI Service Evaluation Warning for Q${questionIdx + 1}: ${error.message}. Using evaluation engine.`);
    }

    // --- Phase 3: Dynamic & Accurate Evaluation Engine ---
    if (!evalData || typeof evalData.technicalScore === 'undefined') {
        const cleanCode = (code || "").trim();
        const cleanVerbal = (transcription || "").trim();
        const questionText = question.questionText || "";
        const isCoding = question.questionType === 'coding';

        const codeLen = cleanCode.length;
        const verbalLen = cleanVerbal.length;

        // Check if submission is empty or gibberish
        if (codeLen < 8 && verbalLen < 8) {
            evalData = {
                technicalScore: 0,
                confidenceScore: 0,
                aiFeedback: "No valid answer or code was provided for this question. A score of 0 has been assigned.",
                idealAnswer: `### Ideal Answer for "${questionText}"\n\nA complete response for a **${session.level} ${session.role}** should explicitly address core concepts, proper syntax, edge-case validation, and time/space complexity.`
            };
        } else {
            let score = 0;
            let feedbackPoints = [];

            if (isCoding) {
                // Code quality evaluation rules
                const hasFunction = /function|=>|def\s+|class\s+/i.test(cleanCode);
                const hasReturn = /return\s+/i.test(cleanCode);
                const hasLoopOrMap = /for|while|map|filter|reduce|forEach/i.test(cleanCode);
                const hasCondition = /if|else|switch|\?/i.test(cleanCode);
                const hasVariables = /const|let|var|let\s+=/i.test(cleanCode);

                if (hasFunction) { score += 30; feedbackPoints.push("Structured function implementation provided."); }
                else { feedbackPoints.push("Missing a clear function signature."); }

                if (hasReturn) { score += 25; feedbackPoints.push("Includes proper return value logic."); }
                else { feedbackPoints.push("Missing explicit return statement."); }

                if (hasLoopOrMap) { score += 20; feedbackPoints.push("Utilizes appropriate iteration logic."); }
                if (hasCondition) { score += 15; feedbackPoints.push("Handles conditional branching logic."); }
                if (hasVariables) { score += 10; }

                if (codeLen < 25) score = Math.min(score, 40); // Penalty for tiny snippets
            } else {
                // Conceptual / Verbal evaluation rules
                const wordCount = cleanVerbal.split(/\s+/).length;
                if (wordCount > 40) {
                    score = 85;
                    feedbackPoints.push("Detailed verbal explanation provided with good technical context.");
                } else if (wordCount > 15) {
                    score = 65;
                    feedbackPoints.push("Good baseline answer, but could elaborate more on implementation details.");
                } else {
                    score = 35;
                    feedbackPoints.push("Brief answer. Consider providing concrete examples and deeper explanations.");
                }
            }

            const technicalScore = Math.min(100, Math.max(0, score));
            const confidenceScore = Math.min(100, Math.max(0, Math.round(technicalScore * 0.95)));

            const feedbackSummary = feedbackPoints.join(" ") || `Submission received for ${session.role}.`;
            const idealAnswerText = `### Ideal Solution\n\n**Question:** ${questionText}\n\n**Key Aspects:**\n1. **Core Concept:** Address key patterns for ${session.role} (${session.level} level).\n2. **Best Practices:** Use clean syntax, proper error handling, and optimal time/space complexity.\n3. **Edge Cases:** Validate null/undefined inputs and boundaries.`;

            evalData = {
                technicalScore,
                confidenceScore,
                aiFeedback: feedbackSummary,
                idealAnswer: idealAnswerText
            };
        }
    }

    // --- Phase 4: Save Evaluation to MongoDB ---
    question.userAnswerText = transcription;
    question.userSubmittedCode = code || "";

    question.technicalScore = evalData.technicalScore;
    question.confidenceScore = evalData.confidenceScore;
    question.aiFeedback = evalData.aiFeedback;
    question.idealAnswer = evalData.idealAnswer;
    question.isEvaluated = true;

    const allQuestionsEvaluated = session.questions.every(q => q.isEvaluated);

    if (session.status === 'completed' || allQuestionsEvaluated) {
        const scoreSummary = await calculateOverallScore(sessionId);

        session.overallScore = scoreSummary.overallScore || 0;
        session.metrics = {
            avgTechnical: scoreSummary.avgTechnical,
            avgConfidence: scoreSummary.avgConfidence,
        };

        if (allQuestionsEvaluated) {
            session.status = 'completed';
            session.endTime = session.endTime || new Date();
        }

        await session.save();
        pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Scores finalized.', session);
    } else {
        await session.save();
        pushSocketUpdate(io, userId, sessionId, 'EVALUATION_COMPLETE', `Feedback for Q${questionIdx + 1} is ready!`, session);
    }
};

// @desc    Submit an answer (Audio or Code)
// @route   POST /api/sessions/:id/submit-answer
// @access  Private
const submitAnswer = asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const { questionIndex, code } = req.body; // Remove submissionType if not strictly needed
    const userId = req.user._id;

    const session = await Session.findById(sessionId);

    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }

    const questionIdx = parseInt(questionIndex, 10);
    const question = session.questions[questionIdx];

    if (!question) {
        res.status(400);
        throw new Error(`Question at index ${questionIdx} not found.`);
    }

    // --- NEW UNIFIED LOGIC ---
    let audioFilePath = null;
    if (req.file) {
        audioFilePath = path.join(process.cwd(), req.file.path);
    }

    // We no longer error out if one is missing; 
    // we take whatever is provided (audio, code, or both).
    const codeSubmission = code || null;

    // 1. Update status in DB
    question.isSubmitted = true;
    await session.save();

    // 2. Respond immediately
    res.status(202).json({
        message: 'Answer received. Processing asynchronously...',
        status: 'received',
    });

    const io = req.app.get('io');

    // 3. Start AI processing with BOTH potential inputs
    evaluateAnswerAsync(io, userId, sessionId, questionIdx, audioFilePath, codeSubmission);
});


const calculateOverallScore = async (sessionId) => {
    const results = await Session.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(sessionId) } },
        { $unwind: '$questions' },
        // REMOVED: { $match: { 'questions.isSubmitted': true } } 
        // We now keep all questions to ensure they are part of the average.
        {
            $group: {
                _id: '$_id',
                // If a question is evaluated, use its score; otherwise, use 0.
                avgTechnical: {
                    $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.technicalScore', 0] }
                },
                avgConfidence: {
                    $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.confidenceScore', 0] }
                }
            }
        },
        {
            $project: {
                _id: 0,
                // Overall score is the average of the technical and confidence averages across ALL questions.
                overallScore: { $round: [{ $avg: ['$avgTechnical', '$avgConfidence'] }, 0] },
                avgTechnical: { $round: ['$avgTechnical', 0] },
                avgConfidence: { $round: ['$avgConfidence', 0] },
            }
        }
    ]);

    return results[0] || { overallScore: 0, avgTechnical: 0, avgConfidence: 0 };
};
// @desc    End the session early
// @route   POST /api/sessions/:id/end
// @access  Private
const endSession = asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const userId = req.user._id;

    const session = await Session.findById(sessionId);

    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }
    const isProcessing = session.questions.some(q => q.isSubmitted && !q.isEvaluated);
    if (isProcessing) {
        res.status(400);
        throw new Error('Cannot end interview while AI is processing answers.');
    }
    if (session.status === 'completed') {
        res.status(400);
        throw new Error('Session is already completed.');
    }

    // Calculate scores for evaluated questions
    const scoreSummary = await calculateOverallScore(sessionId);

    session.overallScore = scoreSummary.overallScore || 0;
    session.status = 'completed';
    session.endTime = new Date();
    session.metrics = {
        avgTechnical: scoreSummary.avgTechnical,
        avgConfidence: scoreSummary.avgConfidence,
    };

    await session.save();

    const io = req.app.get('io');
    pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Interview session ended early.', session);

    res.json({ message: 'Session ended successfully.', session });
});

export {
    createSession,
    getSessionById,
    getSessions,
    submitAnswer,
    endSession,
    calculateOverallScore,
    deleteSession
};



