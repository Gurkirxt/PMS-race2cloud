import Express from "express";
import {
  getSecurityList,
  getSecurityDetails,
} from "../../controller/security/securityController.js";

const router = Express.Router();

router.get("/list", getSecurityList);
router.get("/details", getSecurityDetails);

export default router;
