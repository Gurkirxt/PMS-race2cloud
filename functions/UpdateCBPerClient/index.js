module.exports = (event, context) => {
    const DATA = event.data; //event data
    const TIME = event.time; //event occured time

    const RAW_DATA = event.getRawData();
	console.log("RAW DATA ",JSON.stringify(RAW_DATA));

    const SOURCE_ACTION = event.getAction(); //(insert | fetch | invoke ...)
    const SOURCE_TYPE = event.getSource(); //(datastore | cache | queue ...)
    const SOURCE_ENTITY_ID = event.getSourceEntityId(); //if type is datastore then entity id is tableid
    const SOURCE_BUS_DETAILS = event.getEventBusDetails(); //event bus details

    const PROJECT_DETAILS = event.getProjectDetails(); //event project details

    /*
        CONTEXT FUNCTIONALITIES
    */
    context.closeWithSuccess(); //end of application with success
    // context.closeWithFailure(); //end of application with failure
}