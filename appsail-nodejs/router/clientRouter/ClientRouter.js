import Express from "express";
import {
  getClientList,
  getClientDetails,
} from "../../controller/client/clientController.js";

const router = Express.Router();

router.get("/list", getClientList);
router.get("/details", getClientDetails);

export default router;
