// controllers/vendorApplicationController.js
// =============================================================================
// PHASE V — VENDOR APPLICATION CONTROLLER
//
// Endpoints:
//   POST /api/vendor/apply              — Submit vendor application
//   GET  /api/vendor/application-status — Check current application status
//   GET  /api/vendor/applications       — Admin: list all pending applications
//   POST /api/vendor/applications/:id/review — Admin: approve/reject
// =============================================================================

/**
 * POST /api/vendor/apply
 * Submit a new vendor application (non-vendors only)
 */
exports.submitApplication = async (req, res) => {
  const prisma = req.app.get('prisma');
  const userId = req.user.id;

  try {
    // Check if user is already a vendor
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user.role === 'VENDOR') {
      return res.status(400).json({
        success: false,
        message: 'You are already a vendor.',
      });
    }

    // Check if there's already a pending/under-review application
    const existing = await prisma.vendorApplication.findFirst({
      where: {
        userId,
        status: { in: ['PENDING', 'UNDER_REVIEW'] },
      },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'You already have a pending application. Please wait for review.',
        applicationId: existing.id,
        status: existing.status,
      });
    }

    const {
      legalName,
      dateOfBirth,
      country,
      idType,
      addressStreet,
      addressCity,
      addressRegion,
      addressPostal,
      sourceOfFunds,
      sourceOfFundsOther,
      monthlyVolumeEstimate,
      hasPreviousExperience,
      previousPlatforms,
      paymentMethods,
      acceptedTerms,
      collateralAmount,
      idImageFront,
      idImageBack,
      selfieWithId,
      proofOfAddress,
    } = req.body;

    // Validate required fields
    if (!legalName || !dateOfBirth || !country || !idType || !addressStreet || !addressCity || !addressRegion) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields. All identity and address fields are mandatory.',
      });
    }

    if (!acceptedTerms) {
      return res.status(400).json({
        success: false,
        message: 'You must accept the vendor terms and conditions.',
      });
    }

    if (!paymentMethods || !Array.isArray(paymentMethods) || paymentMethods.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'At least 2 payment methods are required.',
      });
    }

    // Map volume estimate string to enum
    const volumeMap = {
      '$0 – $1,000': 'TIER_1',
      '$1,000 – $5,000': 'TIER_2',
      '$5,000 – $20,000': 'TIER_3',
      '$20,000+': 'TIER_4',
    };

    // Map source of funds to enum
    const sourceMap = {
      'Employment income': 'EMPLOYMENT',
      'Business income': 'BUSINESS',
      'Investments': 'INVESTMENTS',
      'Savings': 'SAVINGS',
      'Other': 'OTHER',
    };

    const application = await prisma.vendorApplication.create({
      data: {
        userId,
        legalName,
        dateOfBirth,
        country,
        idType,
        addressStreet,
        addressCity,
        addressRegion,
        addressPostal: addressPostal || null,
        sourceOfFunds: sourceMap[sourceOfFunds] || 'EMPLOYMENT',
        sourceOfFundsOther: sourceOfFundsOther || null,
        monthlyVolumeEstimate: volumeMap[monthlyVolumeEstimate] || 'TIER_1',
        hasPreviousExperience: hasPreviousExperience || false,
        previousPlatforms: previousPlatforms || null,
        paymentMethods: paymentMethods,
        acceptedTerms: true,
        collateralAmount: collateralAmount || 500,
        idImageFront: idImageFront || null,
        idImageBack: idImageBack || null,
        selfieWithId: selfieWithId || null,
        proofOfAddress: proofOfAddress || null,
      },
    });

    logger.info(`✅ [Vendor] New application submitted: user=${userId}, app=${application.id}`);

    // Notify admin War Room in real-time via socket
    try {
      const io = req.app.get('socketio');
      if (io) {
        io.to('admin_spy_room').emit('vendor_application_new', {
          applicationId: application.id,
          userId,
          username: user.username,
          legalName,
          country,
          createdAt: application.createdAt,
        });
      }
    } catch (_) { /* non-fatal */ }

    return res.status(201).json({
      success: true,
      message: 'Application submitted successfully. Our team will review within 24-48 hours.',
      applicationId: application.id,
      status: application.status,
    });
  } catch (error) {
    logger.error('❌ [Vendor] Application submission error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again.',
    });
  }
};

/**
 * GET /api/vendor/application-status
 * Get the current user's latest vendor application status
 */
exports.getApplicationStatus = async (req, res) => {
  const prisma = req.app.get('prisma');
  const userId = req.user.id;

  try {
    const application = await prisma.vendorApplication.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        rejectionReason: true,
        createdAt: true,
        reviewedAt: true,
      },
    });

    if (!application) {
      return res.status(200).json({
        success: true,
        status: 'NONE',
        message: 'No vendor application found.',
      });
    }

    return res.status(200).json({
      success: true,
      applicationId: application.id,
      status: application.status,
      rejectionReason: application.rejectionReason,
      submittedAt: application.createdAt,
      reviewedAt: application.reviewedAt,
    });
  } catch (error) {
    logger.error('❌ [Vendor] Status check error:', error);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/vendor/applications (ADMIN)
 * List all vendor applications for admin review
 */
exports.listApplications = async (req, res) => {
  const prisma = req.app.get('prisma');
  const { status, page = 1, limit = 20 } = req.query;

  try {
    const where = {};
    if (status) where.status = status;

    const [applications, total] = await Promise.all([
      prisma.vendorApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: parseInt(limit),
        include: {
          user: {
            select: {
              id: true,
              username: true,
              email: true,
              kycStatus: true,
              tradesCompleted: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.vendorApplication.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      applications,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('❌ [Vendor] List applications error:', error);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/vendor/applications/:id/review (ADMIN)
 * Approve or reject a vendor application
 * Body: { decision: 'APPROVED'|'REJECTED', reason?, adminNotes? }
 */
exports.reviewApplication = async (req, res) => {
  const prisma = req.app.get('prisma');
  const { id } = req.params;
  const { decision, reason, adminNotes } = req.body;
  const adminId = req.user.id;

  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({
      success: false,
      message: 'Decision must be APPROVED or REJECTED.',
    });
  }

  try {
    const application = await prisma.vendorApplication.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found.' });
    }

    if (application.status === 'APPROVED' || application.status === 'REJECTED') {
      return res.status(400).json({
        success: false,
        message: `Application already ${application.status.toLowerCase()}.`,
      });
    }

    // Update application status
    const updated = await prisma.$transaction(async (tx) => {
      const app = await tx.vendorApplication.update({
        where: { id },
        data: {
          status: decision,
          reviewedBy: adminId,
          reviewedAt: new Date(),
          rejectionReason: decision === 'REJECTED' ? (reason || 'Application did not meet requirements.') : null,
          adminNotes: adminNotes || null,
        },
      });

      // If approved, upgrade user to VENDOR + bump tokenVersion
      if (decision === 'APPROVED') {
        await tx.user.update({
          where: { id: application.userId },
          data: {
            role: 'VENDOR',
            tokenVersion: { increment: 1 },
          },
        });

        // Revoke all existing refresh tokens (force re-login with new role)
        await tx.refreshToken.updateMany({
          where: { userId: application.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      return app;
    });

    const action = decision === 'APPROVED' ? 'approved' : 'rejected';
    logger.info(`✅ [Vendor] Application ${id} ${action} by admin ${adminId}`);

    // Send in-app notification to user about application result
    try {
      const notificationService = req.app.get('notificationService');
      if (notificationService) {
        const title = decision === 'APPROVED'
          ? 'Vendor Application Approved!'
          : 'Vendor Application Update';
        const body = decision === 'APPROVED'
          ? 'Congratulations! Your vendor application has been approved. Log out and log back in to access vendor features.'
          : `Your vendor application has been rejected.${reason ? ' Reason: ' + reason : ''} You may submit a new application.`;

        await notificationService.sendNotification({
          userId: application.userId,
          title,
          body,
          category: 'SYSTEM',
          actionPayload: { action: 'VENDOR_APPLICATION_RESULT', decision },
        });
      }
    } catch (notifErr) {
      logger.error({ err: notifErr }, '⚠️ [Vendor] Failed to send in-app notification');
    }

    // Send email notification to user about application result
    try {
      const emailService = req.app.get('emailService');
      if (emailService && application.user.email) {
        const userName = application.user.username || 'Vendor Applicant';
        const subject = decision === 'APPROVED'
          ? '🎉 Your Azaman Vendor Application Has Been Approved!'
          : '❌ Azaman Vendor Application Update';

        const approvedHtml = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #10b981;">Congratulations, ${userName}! 🎉</h2>
            <p>Your vendor application has been <strong>approved</strong>.</p>
            <p>You now have full access to vendor features on Azaman:</p>
            <ul>
              <li>Create buy/sell ads on the P2P marketplace</li>
              <li>Access vendor analytics dashboard</li>
              <li>Earn XP and climb the leaderboard</li>
            </ul>
            <p>Please log out and log back in to activate your new vendor privileges.</p>
            <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">— The Azaman Team</p>
          </div>
        `;

        const rejectedHtml = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #ef4444;">Application Update</h2>
            <p>Hi ${userName},</p>
            <p>Unfortunately, your vendor application has been <strong>rejected</strong>.</p>
            ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
            <p>You may submit a new application after addressing the issues above. If you believe this was an error, please contact our support team.</p>
            <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">— The Azaman Team</p>
          </div>
        `;

        const htmlContent = decision === 'APPROVED' ? approvedHtml : rejectedHtml;
        const textContent = decision === 'APPROVED'
          ? `Congratulations ${userName}! Your vendor application has been approved. Log out and log back in to access vendor features.`
          : `Hi ${userName}, your vendor application has been rejected.${reason ? ' Reason: ' + reason : ''} You may submit a new application after addressing the issues.`;

        await emailService.sendEmail(application.user.email, subject, htmlContent, textContent);
        logger.info(`📧 [Vendor] Notification email sent to ${application.user.email} (${action})`);
      }
    } catch (emailErr) {
      // Don't fail the review if email fails — log and continue
      logger.error({ err: emailErr }, '⚠️ [Vendor] Failed to send notification email');
    }

    return res.status(200).json({
      success: true,
      message: `Application ${action} successfully.`,
      application: updated,
    });
  } catch (error) {
    logger.error('❌ [Vendor] Review error:', error);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};
